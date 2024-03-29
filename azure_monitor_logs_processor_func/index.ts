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
import axios, { AxiosError, AxiosInstance } from "axios"
import axiosRetry from "axios-retry"
import * as moment from "moment"
import { gzip } from 'node-gzip';

const DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES = 1 * 1000 * 1000;

/* This constant mirrors the timeout setting in host.json */
const FUNC_TIMEOUT = 10 * 60 * 1000;
const INIT_TIME = 2 * 60 * 1000;
const WRITE_TIME = 30 * 1000;
const BUFFER = 30 * 1000;
const MAX_RETRIES = 2;
const AZURE_LOG_LIMIT = 32000;

/**
 * Entrypoint for function that handles a list of events.
 * @param context The context of the current function execution.
 * @param eventHubMessages The events being processed, Each event contains an EventHub message. Each message contains
 * an array of logs.
 */
const azureMonitorLogsProcessorFunc: SplunkAzureFunction = async function (
  { log, bindings, bindingData }: SplunkContext,
  eventHubMessages: any[]): Promise<void> {

  log.verbose(`Starting function with environment ${JSON.stringify(process.env)}`);
  try {
    log.info(`Handling ${eventHubMessages.length} event(s)`);
    const startTime = Date.now();
    const payloads = buildHecPayloads(log, eventHubMessages, bindingData);
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
function buildHecPayloads(log: Logger, eventHubMessages: any[], bindingData: ContextBindingData): string[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) into payloads for HEC.`);

  const batchSize = parseInt(process.env.SPLUNK_BATCH_MAX_SIZE_BYTES || '');
  const splunkEvents = toSplunkEvents(log, eventHubMessages, bindingData);
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
function toSplunkEvents(log: Logger, eventHubMessages: any[], bindingData: ContextBindingData): SplunkEvent[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) to Splunk events.`);
  const splunkEvents: SplunkEvent[] = [];
  const enableEventhubMetadata = enabledEventhubMetadata();

  for (let i = 0;i < eventHubMessages.length; i++) {
    const eventHubMessage = eventHubMessages[i];
    log.verbose(`Mapping to Splunk event: ${JSON.stringify(eventHubMessage)}`);
    for (const record of eventHubMessage.records) {
      if (enableEventhubMetadata) {
        record.__eventhub_metadata = bindingData.systemPropertiesArray[i];
      }
      splunkEvents.push(toSplunkEvent(record));
    }
  }
  log.info(`Mapped ${eventHubMessages.length} EventHub message(s) to ${splunkEvents.length} Splunk event(s).`);
  return splunkEvents;
}

/**
 * Map a single record into a Splunk event.
 * @param record the record to map.
 */
function toSplunkEvent(record: any): SplunkEvent {
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

  return splunkEvent;
}

/**
 * Get the source to be set on every event.
 */
function getSource(): string {
  const regex = new RegExp('.*Endpoint=sb://(.+)\.servicebus\.windows\.net.*');
  const match = (process.env.EventHubConnection ?? '').match(regex) ?? [];

  const region = process.env.Region ?? 'unknown-region'
  const namespace = match.length > 1 ? match[1] : 'unknown-namespace';
  const eventHub = process.env.EventHubName ?? 'unknown-eventhub'

  return `azure:${region}:${namespace}:${eventHub}`;
}

/**
 * Try to extract a timestamp from a record.
 * @param record the record to extract a timestamp from.
 */
function tryExtractTimestamp(record: any): number | undefined {
  if (!record.hasOwnProperty('time')) {
    return undefined;
  }
  const time = moment.utc(record.time).valueOf();
  if (isNaN(time)) {
    return undefined;
  }
  return time;
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

  if(response.headers &&
      response.headers['content-type'] &&
      response.headers['content-type'].includes('application/json') &&
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
