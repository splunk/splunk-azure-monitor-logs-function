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
import { Context, ContextBindings, Logger } from "@azure/functions"
import axios, { AxiosInstance } from "axios"
import * as moment from "moment"

const DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES = 1 * 1000 * 1000;

/**
 * Entrypoint for function that handles a list of events.
 * @param context The context of the current function execution.
 * @param eventHubMessages The events being processed, Each event contains an EventHub message. Each message contains
 * an array of logs.
 */
const azureMonitorLogsProcessorFunc: SplunkAzureFunction = async function (
  {log, bindings}: SplunkContext,
  eventHubMessages: any[]): Promise<void> {

  log.verbose(`Starting function with environment ${JSON.stringify(process.env)}`);

  try {
    const hecHttpClient = createHecHttpClient(log, process.env.HecUrl, process.env.HecToken);
    log.info(`Handling ${eventHubMessages.length} event(s)`);
    const payloads = buildHecPayloads(log, eventHubMessages);

    log.info(`Sending ${payloads.length} payload(s) to Splunk`);
    const failedPayloads: string[] = [];
    for (const payload of payloads) {
      try {
        await pushToHec(log, hecHttpClient, payload);
      } catch (error) {
        log.error(`Failed to push to HEC.\n${error.stack ?? 'Error: ' + error}\nPayload: ${payload}`);
        failedPayloads.push(payload);
      }
    }

    log.info(`Finished sending ${payloads.length} payload(s) to Splunk`);
    handlePushErrors(log, bindings, failedPayloads);
  } catch (error) {
    handleGlobalError(log, bindings, error, eventHubMessages);
  }

  log.info(`Finished handling ${eventHubMessages.length} event(s)`);
};


/**
 * Create an HTTP client used for sending data via HEC.
 * @param log the logger to use.
 * @param hecUrl the base url for all HTTP requests.
 * @param hecToken the HEC token added as a default header.
 */
function createHecHttpClient(log: Logger, hecUrl: string | undefined, hecToken: string | undefined): AxiosInstance {
  if (hecUrl === undefined) {
    throw new Error('HecUrl is not defined');
  }

  const headers = {
    'Authorization': `Splunk ${hecToken}`
  };
  log.info(`Creating HTTP client baseUrl='${hecUrl}' headers='${JSON.stringify(headers)}'`);
  return axios.create({
    baseURL: hecUrl,
    headers: headers,
    validateStatus: () => true
  });
}

/**
 * Take build HEC payloads from EventHub messages.
 * @param log the logger to use.
 * @param eventHubMessages the EventHub messages to build HEC payloads from.
 */
function buildHecPayloads(log: Logger, eventHubMessages: any[]): string[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) into payloads for HEC.`);

  const batchSize = parseInt(process.env.SPLUNK_BATCH_MAX_SIZE_BYTES || '');
  const splunkEvents = toSplunkEvents(log, eventHubMessages);
  const serializedEvents = splunkEvents.map(e => JSON.stringify(e));
  const batchedEvents = batchSerializedEvents(log, serializedEvents, batchSize || DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES);

  log.info(`Mapped ${eventHubMessages.length} EventHub message(s) into ${batchedEvents.length} payload(s) for HEC.`);
  return batchedEvents;
}

/**
 * Map EventHub messages into Splunk events.
 * @param log the logger to use.
 * @param eventHubMessages the EventHub messages to map.
 */
function toSplunkEvents(log: Logger, eventHubMessages: any[]): SplunkEvent[] {
  log.info(`Mapping ${eventHubMessages.length} EventHub message(s) to Splunk events.`);
  const splunkEvents: SplunkEvent[] = [];

  for (const eventHubMessage of eventHubMessages) {
    log.verbose(`Mapping to Splunk event: ${JSON.stringify(eventHubMessage)}`);
    for (const record of eventHubMessage.records) {
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
    },
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
  log.verbose(`Push to HEC with Payload=${payload}`);
  const response = await hecHttpClient.post('services/collector/event', payload);
  log.verbose(`Pushed to HEC and got response with Code=${response.status} Body=${JSON.stringify(response.data)}`);

  if (!(response.status >= 200 && response.status < 300)) {
    throw new Error(`HEC push failed. Code=${response.status}, Body=${JSON.stringify(response.data)}`);
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
  log.error(`Failed before pushing events. Error=${error.stack ?? error}`);

  bindings.failedParseEventsOutputBlob = eventHubMessages;
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
