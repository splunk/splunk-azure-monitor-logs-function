"""
Copyright 2021 Splunk, Inc.

Licensed under the Apache License, Version 2.0 (the "License"): you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations
under the License.
"""

import json
import logging
import os
import re
from typing import Dict
from typing import List

import azure.functions as func
import requests

# The maximum size of the payload to send to the Splunk HEC endpoint
SPLUNK_BATCH_MAX_SIZE_BYTES = 1 * 1000 * 1000


def main(events: List[func.EventHubEvent],  # pylint: disable=invalid-name
         failedParseEventsOutputBlob: func.Out[bytes],
         failedSendEventsOutputBlob: func.Out[bytes]):
    """Entrypoint for function that handles a list of events.

    :param events: the events being processed. Each event contains an Eventhub message. Each message
     contains an array of logs.
    :param failedEventsOutputBlob: the blob where failed to deliver events should be saved
    """
    try:
        init_root_logger()

        logging.info('Handling %s event(s)', len(events))
        logging.debug('Starting with environment %s', os.environ)
        url = '%s/services/collector/event' % os.environ["HecUrl"]
        headers = {
            'Authorization': 'Splunk %s' % os.environ["HecToken"],
        }
        payloads = build_payloads(events)
    except Exception as err:  # pylint: disable=broad-except
        handle_prepush_exception(err, events, failedParseEventsOutputBlob)
        return

    logging.info('Sending %s payload(s) to Splunk', len(payloads))
    failed_payloads = []
    for payload in payloads:
        try:
            push_to_hec(url, headers, payload)
        except Exception as err:  # pylint: disable=broad-except
            logging.error('Failed to push to HEC. err:%s \npayload:%s', err, payload, exc_info=err)
            failed_payloads.append(payload)

    handle_push_exceptions(failed_payloads, failedSendEventsOutputBlob)
    logging.info('Finished handling %s event(s)', len(events))


def init_root_logger():
    """Initialize the root logger. We must set the log level because it gets set by the function
    worker to INFO. Another way of doing this is to pass the worker a command line argument of
    '--log-level DEBUG' but is cumbersome to do when deploying. It is easier to just set it in
    code.

    For more details, see:
    https://github.com/Azure/azure-functions-python-worker/issues/248
    """
    logging.Logger.root.setLevel(level=logging.getLevelName(
        os.environ.get("LogLevel", "INFO").upper()))


def build_payloads(events: List[func.EventHubEvent]) -> List[str]:
    logging.info('Mapping %s EventHub event(s) into payloads for HEC', len(events))

    splunk_events = to_splunk_events(events)
    serialized_splunk_events = [json.dumps(event, separators=(',', ':')) for event in splunk_events]
    batched_events = batch_events(serialized_splunk_events)

    logging.info('Mapped %s EventHub event(s) into %s payload(s) for HEC', len(events),
                 len(batched_events))
    return batched_events


def to_splunk_events(events: List[func.EventHubEvent]) -> List[dict]:
    logging.info('Mapping %s EventHub event(s) to Splunk events', len(events))

    splunk_events = []
    for event in events:
        event_body = event.get_body()
        logging.debug('mapping to splunk event: %s', event_body)
        event_json = json.loads(event_body)
        logs = event_json.get('records')
        for log in logs:
            splunk_events.append(to_splunk_event(log))

    logging.info('Mapped %s EventHub event(s) to Splunk events', len(events))

    return splunk_events


def batch_events(splunk_events: List[str]) -> List[str]:
    logging.info('Batching %s Splunk event(s) into payloads for HEC', len(splunk_events))
    if not splunk_events:
        return []

    batches = ['']
    for splunk_event_json in splunk_events:
        current_batch = batches[-1]
        potential_size = len(splunk_event_json) + len(current_batch)
        if not current_batch or potential_size <= SPLUNK_BATCH_MAX_SIZE_BYTES:
            batches[-1] = current_batch + splunk_event_json
        else:
            batches.append(splunk_event_json)

    logging.info('Batched %s Splunk event(s) into %s payload(s) for HEC', len(splunk_events),
                 len(batches))
    return batches


def push_to_hec(url: str, headers: Dict, payload: str) -> None:
    logging.info('Push to hec with url=%s headers=%s', url, headers)
    logging.debug('Push to hec with payload=%s', payload)

    response = requests.post(url=url, headers=headers, data=payload)

    logging.info('Pushed to hec and got response with code=%s msg=%s', response.status_code,
                 response.text)
    if not response.ok:
        raise Exception('HEC push failed. code:%s msg:%s' % (response.status_code, response.text))


def to_splunk_event(log: Dict) -> Dict:
    return {
        'event': log,
        'source': get_source(),
        'sourcetype': os.environ["SourceType"],
    }


def get_source() -> str:
    region = os.environ["Region"]
    eventhub_connection = os.environ["EventHubConnection"]
    regex = r'.*Endpoint=sb://(.+)\.servicebus\.windows\.net.*'
    match = re.compile(regex).match(eventhub_connection)
    eventhub_namespace = match.group(1)
    eventhub_name = os.environ["EventHubName"]

    return 'azure:%s:%s:%s' % (region, eventhub_namespace, eventhub_name)


def handle_prepush_exception(exception: Exception,
                             events: List[func.EventHubEvent],
                             output_blob: func.Out[bytes]) -> None:
    logging.error('Failed before pushing events. err: %s events: %s', exception, events,
                  exc_info=exception)
    event_body_list = []
    for event in events:
        event_body = event.get_body()
        event_body_list.append(event_body)

    event_body_output = b'%s' % (b'\n'.join(event_body_list))
    output_blob.set(event_body_output)
    logging.info('Backed up %s EventHub event(s) to blob storage', len(events))


def handle_push_exceptions(failed_requests: list, output_blob: func.Out[bytes]) -> None:
    if not failed_requests:
        return

    output_string = '\n'.join(failed_requests)
    output_blob.set(output_string)
    logging.info('Backed up %s failed requests to blob storage', len(failed_requests))
