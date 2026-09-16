/**
 * Copyright 2021 Splunk, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"): you may
 * not use this file except in compliance with the License. You may obtain
 * a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 */
import { Context, ContextBindings, ContextBindingData, Logger } from "@azure/functions"
import Ajv, { ValidateFunction } from "ajv"
import axios, { AxiosError, AxiosInstance } from "axios"
import axiosRetry from "axios-retry"
import * as moment from "moment"
import { gzip } from 'node-gzip';

/**
 * Minimal event-identifying floor — replaced an earlier 9-branch per-category model that
 * bought little real security (Event Hub Send permission is the actual boundary) and
 * fought the goal of never losing a legitimate event with an unanticipated shape.
 *
 * Presence-only check: does the record contain any one of these "what kind of event is
 * this" field names, seen across every shape modeled historically? A record that fails
 * this is still forwarded to Splunk unmodified, not blocked — see toSplunkEvents.
 * `minLength: 1` closes the null/empty-string bypass plain `required` would allow.
 */
const EVENT_IDENTIFYING_FIELDS = [
  'operationName', 'OperationName', 'Operation',
  'category', 'Category', 'type', 'Type',
  'Action', 'Status', 'EventType', 'AlertType', 'DisplayName', 'Activity',
];

const MINIMAL_EVENT_FLOOR_SCHEMA = {
  type: 'object',
  anyOf: EVENT_IDENTIFYING_FIELDS.map(field => ({
    required: [field],
    properties: { [field]: { type: 'string', minLength: 1 } },
  })),
  additionalProperties: true,
};

const ajv = new Ajv({ strict: false, allErrors: true });
const validateAzureMonitorLogRecord: ValidateFunction<AzureMonitorLogRecord> = ajv.compile(MINIMAL_EVENT_FLOOR_SCHEMA);

const DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES = 1 * 1000 * 1000;

/* This constant mirrors the timeout setting in host.json */
const FUNC_TIMEOUT = 10 * 60 * 1000;
const INIT_TIME = 2 * 60 * 1000;
const WRITE_TIME = 30 * 1000;
const BUFFER = 30 * 1000;
const MAX_RETRIES = 2;
const AZURE_LOG_LIMIT = 32000;
const RESOURCE_LOG_TYPE_DELIMETER = "PROVIDERS/";
/**
 * Entrypoint for function that handles a list of events.
 * @param context The context of the current function execution.
 * @param eventHubMessages The events being processed, Each event contains an EventHub message. Each message contains
 * an array of logs.
 */
const azureMonitorLogsProcessorFunc: SplunkAzureFunction = async function (
  { log, bindings, bindingData }: SplunkContext,
  eventHubMessages: any[]): Promise<void> {

  try {
    log.info(`Handling ${eventHubMessages.length} event(s)`);
    const startTime = Date.now();
    const invalidMessages: unknown[] = [];
    const payloads = buildHecPayloads(log, eventHubMessages, bindingData, invalidMessages);
    const { hecUrl, hecToken } = getHecParams();
    const timeToBuild = Date.now() - startTime;

    /**
     * To prevent the timeout from being negative set a minimum timeout of 1ms.
     * In the event eventHubMessages is empty, payloads.length = 0. Set a minimum of 1 to prevent divide by zero error
     * This will cause the HEC request to fail immediately and be written to storage
     */
    const timeout = Math.max(((FUNC_TIMEOUT - INIT_TIME - WRITE_TIME - BUFFER - timeToBuild) / (MAX_RETRIES + 1)), 1) / Math.max(1, payloads.length);

    const hecHttpClient = createHecHttpClient(log, hecUrl, hecToken, timeout);

    log.info(`Sending ${payloads.length} payload(s) to Splunk`);
    const failedPayloads: string[] = [];
    for (const payload of payloads) {
      try {
        await pushToHec(log, hecHttpClient, payload);
      } catch (error: any) {
        failedPayloads.push(payload);
        const errorMessage = (error.stack ?? 'Error: ' + error).slice(0, AZURE_LOG_LIMIT);
        log.error(`Failed to push to HEC. Error: ${errorMessage}`);
      }
    }

    log.info(`Finished sending ${payloads.length} payload(s) to Splunk`);
    handlePushErrors(log, bindings, failedPayloads);
    handleInvalidMessages(log, bindings, invalidMessages);
  } catch (error) {
    handleGlobalError(log, bindings, error, eventHubMessages);
  }

  log.info(`Finished handling ${eventHubMessages.length} event(s)`);
};

function getHecParams(): HecParams {
  const hecUrl = process.env.HecUrl;
  const hecToken = process.env.HecToken;

  if (hecUrl === undefined) {
    throw new Error('HecUrl is not defined');
  }

  if (hecToken === undefined) {
    throw new Error('HecToken is not defined');
  }

  return { hecUrl, hecToken };
}

function enabledEventhubMetadata(): boolean {
  const enableEventhubMetadata = process.env.EnableEventhubMetadata;
  return enableEventhubMetadata === "true";
}

/**
 * Return if error can be resolved by a retry
 * @param error error returned by Axios Client
 * @returns error can be retried
 */
function isRetryableError(error: AxiosError): boolean {
  return (
    axiosRetry.isNetworkError(error) ||
    error.code === 'ENOTFOUND' ||   // ENOTFOUND is not considered a retryable error by axios.
                                    // Intermittent ENOTFOUND errors were observed during performance tests due to high load/Node issues
    (error.response?.status == 408 || // HEC Request Timeout
      error.response?.status == 429 || // HEC Throttling
      (
        error.response != undefined &&
        error.response.status >= 500 &&
        error.response.status <= 599
      )
    )
  );
}

function getRetryDelay(retryCount: number, error: AxiosError): number {
  // No delay unless throttling occurs
  return (error.response?.status == 429) ? axiosRetry.exponentialDelay(retryCount) : 0;
}

/**
 * Create an HTTP client used for sending data via HEC.
 * @param log the logger to use.
 * @param hecUrl the base url for all HTTP requests.
 * @param hecToken the HEC token added as a default header.
 * @param timeout the timeout value for the HTTP client in ms
 */
function createHecHttpClient(log: Logger, hecUrl: string, hecToken: string, timeout: number): AxiosInstance {
  const headers = {
    'Authorization': `Splunk ${hecToken}`,
    'Content-Encoding': 'gzip',
  };
  log.info(`Creating HTTP client baseUrl='${hecUrl}'`);
  const client = axios.create({
    baseURL: hecUrl,
    headers,
    timeout,
    validateStatus: () => true
  });

  axiosRetry(client, {
    retries: MAX_RETRIES,
    retryCondition: isRetryableError,
    retryDelay: getRetryDelay
  });

  return client;
}

/**
 * Take build HEC payloads from EventHub messages.
 * @param log the logger to use.
 * @param eventHubMessages the EventHub messages to build HEC payloads from.
 * @param bindingData the EventHub event metadata, batched the same way as eventHubMessages.
 */
function buildHecPayloads(log: Logger, eventHubMessages: any[], bindingData: ContextBindingData, invalidMessages: unknown[]): string[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) into payloads for HEC.`);

  const batchSize = parseInt(process.env.SPLUNK_BATCH_MAX_SIZE_BYTES || '');
  const splunkEvents = toSplunkEvents(log, eventHubMessages, bindingData, invalidMessages);
  const serializedEvents = splunkEvents.map(e => JSON.stringify(e));
  const batchedEvents = batchSerializedEvents(log, serializedEvents, batchSize || DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES);

  log.info(`Mapped ${eventHubMessages.length} EventHub message(s) into ${batchedEvents.length} payload(s) for HEC.`);
  return batchedEvents;
}

/**
 * Map EventHub messages into Splunk events.
 * @param log the logger to use.
 * @param eventHubMessages the EventHub messages to map.
 * @param bindingData the event metadata to map.
 */
function toSplunkEvents(log: Logger, eventHubMessages: any[], bindingData: ContextBindingData, invalidMessages: unknown[]): SplunkEvent[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) to Splunk events.`);
  const splunkEvents: SplunkEvent[] = [];
  const enableEventhubMetadata = enabledEventhubMetadata();
  const resourceTypeToIndexMap = getResourceTypeToIndexMapping();

  for (let i = 0;i < eventHubMessages.length; i++) {
    const eventHubMessage = eventHubMessages[i];

    if (!eventHubMessage || !Array.isArray(eventHubMessage.records)) {
      log.error(`Quarantining malformed EventHub message at index ${i}: missing or non-array .records`);
      invalidMessages.push(eventHubMessage);
      continue;
    }

    log.verbose(`Mapping to Splunk event: ${JSON.stringify(eventHubMessage)}`);
    for (let j = 0; j < eventHubMessage.records.length; j++) {
      const record = eventHubMessage.records[j];
      // Non-objects (null/undefined/array/primitive) can't be safely enriched, so they're
      // hard-quarantined. An object that fails the event-identifying check is forwarded
      // unmodified instead.
      if (record === null || record === undefined || typeof record !== 'object' || Array.isArray(record)) {
        log.error(`Quarantining malformed record (not an object) in EventHub message ${i}, record ${j}`);
        invalidMessages.push(record);
        continue;
      }

      if (!validateAzureMonitorLogRecord(record)) {
        // No ajv error detail or record content logged — record is untrusted and may be sensitive.
        log.info(`Forwarding record with no recognized event-identifying field in EventHub message ${i}, record ${j} (not quarantined)`);
      }

      if (enableEventhubMetadata) {
        record.__eventhub_metadata = bindingData.systemPropertiesArray[i];
      }
      splunkEvents.push(toSplunkEvent(record, resourceTypeToIndexMap));
    }
  }
  log.info(`Mapped ${eventHubMessages.length} EventHub message(s) to ${splunkEvents.length} Splunk event(s).`);
  return splunkEvents;
}


function getResourceTypeToIndexMapping(): Map<string, string> {
  const resourceTypeIndexEnvVar = process.env.ResourceTypeDestinationIndex || '';
  let resourceTypeToIndexWithLowerCaseKeys: Map<string, string> = new Map<string, string>();
  
  if (resourceTypeIndexEnvVar !== '') {
    const tokenizedKeyValPairs = resourceTypeIndexEnvVar.split(";")

    for (const token of tokenizedKeyValPairs) {
      const keyValPair = token.split("=")

      if (keyValPair.length === 2) {
        const key = keyValPair[0].trim().toLowerCase();
        const val = keyValPair[1].trim();
        resourceTypeToIndexWithLowerCaseKeys.set(key, val)
      }
    }
  }
  return resourceTypeToIndexWithLowerCaseKeys;
}

/**
 * Map a single record into a Splunk event.
 * @param record the record to map.
 * @param resourceTypeToIndexMap Map object of resource log type to index.
 */
function toSplunkEvent(record: any, resourceTypeToIndexMap: Map<string, string>): SplunkEvent {
  let splunkEvent: SplunkEvent = {
    event: record,
    source: getSource(),
    sourcetype: process.env.SourceType,
    fields: {
      data_manager_input_id: process.env.DataManagerInputId,
    }
  }

  const timeStamp = tryExtractTimestamp(record);
  if (timeStamp) {
    splunkEvent.time = timeStamp;
  }

  const index = tryExtractIndexForResourceLogs(record, resourceTypeToIndexMap);
  if (index) {
    splunkEvent.index = index;
  }

  return splunkEvent;
}

/**
 * Process resource type index
 * @param record the record to map.
 * @param resourceTypeToIndexMap Map object of resource log type to index.
 */
function tryExtractIndexForResourceLogs(record: any, resourceTypeToIndexMap: Map<string, string>): string | undefined {
  if (resourceTypeToIndexMap !== undefined) {
    const resourceId = extractResourceIdField(record);
    if (resourceId !== undefined) {
      let eventResourceType = extractResourceType(resourceId, RESOURCE_LOG_TYPE_DELIMETER);

      if (resourceTypeToIndexMap.has(eventResourceType)) {
        return resourceTypeToIndexMap.get(eventResourceType);
      }
    }
  }
}

/**
 * Read the record's resource identifier (lowerCamelCase `resourceId` or WAD/ETW's PascalCase
 * `ResourceId`). Uses `Object.prototype.hasOwnProperty.call`, not `record.hasOwnProperty(...)`
 * — a record with its own `hasOwnProperty` key would otherwise shadow the built-in and throw,
 * crashing the whole invocation (review finding, reproduced and fixed).
 */
function extractResourceIdField(record: any): string | undefined {
  if (Object.prototype.hasOwnProperty.call(record, 'resourceId') && typeof record.resourceId === 'string') {
    return record.resourceId;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'ResourceId') && typeof record.ResourceId === 'string') {
    return record.ResourceId;
  }
  return undefined;
}

/**
 * Try to extract resource log type from the resource Id
 * @param resourceId the resourceId.
 * @param delimiter the boundary after which the resource provider namespace starts - see below
 * /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/resourceProviderNamespace}/{resourceType}/{resourceName}
 */
function extractResourceType(resourceId: string, delimiter: string): string {
  // lastIndexOf performs a literal, case-sensitive search in O(n) time, matching the semantics of the
  // previous greedy regex ('.*' + delimiter) without its ReDoS-prone worst-case backtracking behavior.
  const delimiterIndex = resourceId.lastIndexOf(delimiter);
  const resourceTypeWithResourceName = delimiterIndex === -1
    ? resourceId
    : resourceId.substring(delimiterIndex + delimiter.length);
  // Extract {resourceProviderNamespace}/{resourceType} from {resourceProviderNamespace}/{resourceType}/{resourceName}
  return resourceTypeWithResourceName.substring(0, resourceTypeWithResourceName.lastIndexOf("/")).toLowerCase();
}

/**
 * Get the source to be set on every event.
 */
function getSource(): string {
  const fqns = process.env.EventHubConnection__fullyQualifiedNamespace;
  const namespace = fqns
    ? fqns.replace('.servicebus.windows.net', '')
    : extractNamespaceFromConnectionString(process.env.EventHubConnection ?? '');

  const region = process.env.Region ?? 'unknown-region'
  const eventHub = process.env.EventHubName ?? 'unknown-eventhub'

  return `azure:${region}:${namespace}:${eventHub}`;
}

/**
 * Extract the namespace from an Event Hub connection string, e.g. from
 * "Endpoint=sb://my-namespace.servicebus.windows.net/;..." extract "my-namespace".
 * Uses literal string operations rather than a regex to avoid catastrophic backtracking (CWE-1333)
 * on malformed or unexpectedly long input.
 * @param connectionString the Event Hub connection string.
 */
function extractNamespaceFromConnectionString(connectionString: string): string {
  const suffix = '.servicebus.windows.net';
  const endpointPrefix = 'Endpoint=sb://';
  const endpointIndex = connectionString.indexOf(endpointPrefix);
  if (endpointIndex === -1) {
    return 'unknown-namespace';
  }

  const afterEndpoint = connectionString.substring(endpointIndex + endpointPrefix.length);
  const suffixIndex = afterEndpoint.indexOf(suffix);
  if (suffixIndex === -1) {
    return 'unknown-namespace';
  }

  return afterEndpoint.substring(0, suffixIndex);
}

/**
 * Try to extract a timestamp from a record.
 * @param record the record to extract a timestamp from.
 */
function tryExtractTimestamp(record: any): number | undefined {
  const rawTime = extractTimeField(record);
  if (rawTime === undefined) {
    return undefined;
  }
  const time = moment.utc(rawTime).valueOf();
  if (isNaN(time)) {
    return undefined;
  }
  return time;
}

/**
 * Read the record's raw timestamp value, checking both the common Azure Monitor envelope's
 * lowercase `time` and the WAD/ETW schema's PascalCase `Time`. Uses
 * `Object.prototype.hasOwnProperty.call` rather than `record.hasOwnProperty(...)` — see
 * `extractResourceIdField` above for why the direct method call is unsafe on untrusted input.
 */
function extractTimeField(record: any): any {
  if (Object.prototype.hasOwnProperty.call(record, 'time')) {
    return record.time;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'Time')) {
    return record.Time;
  }
  return undefined;
}

/**
 * Batch serialized events into batches with max size of SPLUNK_BATCH_MAX_SIZE_BYTES.
 * @param log the logger to use.
 * @param serializedEvents the serialized events to batch.
 */
function batchSerializedEvents(log: Logger, serializedEvents: string[], batchSize: number): string[] {
  log.info(`Batching ${serializedEvents.length} Splunk event(s) into payloads for HEC`);
  if (serializedEvents.length == 0) {
    return [];
  }

  const batches = [''];
  for (const serializedEvent of serializedEvents) {
    let currentBatch = batches[batches.length - 1];
    const potentialSize = serializedEvent.length + currentBatch.length;
    if (currentBatch.length == 0 || potentialSize <= batchSize) {
      batches[batches.length - 1] = currentBatch + serializedEvent;
    } else {
      batches.push(serializedEvent);
    }
  }

  log.info(`Batched ${serializedEvents.length} Splunk event(s) into ${batches.length} payload(s) for HEC`);
  return batches;
}

/**
 * Send a payload to the HEC events endpoint.
 * @param log the logger to use.
 * @param hecHttpClient the HTTP client to use.
 * @param payload the payload to send.
 */
async function pushToHec(log: Logger, hecHttpClient: AxiosInstance, payload: string) {
  log.verbose(`Push to HEC with Payload=${payload.slice(0, AZURE_LOG_LIMIT)}`);
  const compressedPayload = await gzip(payload);
  const response = await hecHttpClient.post('services/collector/event', compressedPayload);
  let responseBody = '';

  const contentType = response.headers?.['content-type'];
  if(contentType &&
      String(contentType).includes('application/json') &&
      response.data) {
    responseBody = JSON.stringify(response.data).slice(0, AZURE_LOG_LIMIT);
  } else {
    responseBody = response?.data?.slice(0, AZURE_LOG_LIMIT);
  }

  log.verbose(`Pushed to HEC. Response Code = ${response.status}`);
  log.verbose(`Pushed to HEC. Response Body = ${responseBody}`);

  if (!(response.status >= 200 && response.status < 300)) {
    throw new Error(`HEC push failed. Code=${response.status}, Body=${responseBody}`);
  }
}

/**
 * Handle any errors that were raised before we attempted to push to HEC.
 * @param log the logger to use.
 * @param bindings the bindings containing the output destination for where events should be backed up.
 * @param error the error that was raised.
 * @param eventHubMessages the EventHub messages that need to be backed up.
 */
function handleGlobalError(log: Logger, bindings: SplunkContextBindings, error: any, eventHubMessages: any[]) {
  bindings.failedParseEventsOutputBlob = eventHubMessages;

  log.error(`Failed before pushing events. Error=${error.stack ?? error}`);
  log.info(`Backed up ${eventHubMessages.length} EventHub event(s) to blob storage`);
}

/**
 * Handle any errors that were raised while attempting to push to HEC.
 * @param log the logger to use.
 * @param bindings the bindings containing the output destination for where events should be backed up.
 * @param failedPayloads the payloads that failed to be pushed and need to be backed up.
 */
function handlePushErrors(log: Logger, bindings: SplunkContextBindings, failedPayloads: string[]) {
  if (failedPayloads.length === 0) {
    return;
  }

  bindings.failedSendEventsOutputBlob = failedPayloads.join('\n');
  log.info(`Backed up ${failedPayloads.length} failed request(s) to blob storage`);
}

/**
 * Back up any EventHub messages or records that were quarantined for failing validation.
 * @param log the logger to use.
 * @param bindings the bindings containing the output destination for where events should be backed up.
 * @param invalidMessages the messages or records that failed validation and need to be backed up.
 */
function handleInvalidMessages(log: Logger, bindings: SplunkContextBindings, invalidMessages: unknown[]) {
  if (invalidMessages.length === 0) {
    return;
  }

  bindings.failedParseEventsOutputBlob = invalidMessages;
  log.info(`Backed up ${invalidMessages.length} invalid EventHub message(s)/record(s) to blob storage`);
}

/**
 * A single Azure Monitor diagnostic log record, prior to schema validation.
 */
type AzureMonitorLogRecord = Record<string, any>;

/**
 * Represents params for HEC HTTP Client.
 */
type HecParams = {
  hecUrl: string,
  hecToken: string
};

/**
 * Represents a Splunk event being sent over HEC via events endpoint.
 */
type SplunkEvent = {
  event: object,
  source: string,
  sourcetype: string | undefined,
  index?: string,
  fields: object,
  time?: number,
};

/**
 * Represents the bindings for this Azure Function.
 */
type SplunkContextBindings = ContextBindings & {
  failedParseEventsOutputBlob: any,
  failedSendEventsOutputBlob: any
};

/**
 * Represents the context of this Azure Function.
 */
type SplunkContext = Context & {
  bindings: SplunkContextBindings
};

/**
 * Represents the Splunk Azure Function signature.
 */
type SplunkAzureFunction = ((context: SplunkContext, ...args: any[]) => Promise<any> | void);

export default azureMonitorLogsProcessorFunc;
