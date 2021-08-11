"""Copyright (c) 2021 Splunk, Inc. All rights reserved."""
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
        logging.debug('starting with environment %s', os.environ)
        url = '%s/services/collector/event' % os.environ["HecUrl"]
        headers = {
            'Authorization': 'Splunk %s' % os.environ["HecToken"],
        }
        payloads = build_payloads(events)
    except Exception as err:  # pylint: disable=broad-except
        handle_prepush_exception(err, events, failedParseEventsOutputBlob)
        return

    failed_payloads = []
    for payload in payloads:
        try:
            push_to_hec(url, headers, payload)
        except Exception as err:  # pylint: disable=broad-except
            logging.error('Failed to push to HEC. err:%s \npayload:%s', err, payload)
            failed_payloads.append(payload)

    handle_push_exceptions(failed_payloads, failedSendEventsOutputBlob)


def build_payloads(events: List[func.EventHubEvent]) -> List[str]:
    splunk_events = to_splunk_events(events)
    serialized_splunk_events = [json.dumps(event, separators=(',', ':')) for event in splunk_events]
    return batch_events(serialized_splunk_events)


def to_splunk_events(events: List[func.EventHubEvent]) -> List[dict]:
    splunk_events = []
    for event in events:
        event_body = event.get_body()
        logging.debug('mapping to splunk event: %s', event_body)
        event_json = json.loads(event_body)
        logs = event_json.get('records')
        for log in logs:
            splunk_events.append(to_splunk_event(log))

    return splunk_events


def batch_events(splunk_events: List[str]) -> List[str]:
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

    return batches


def push_to_hec(url: str, headers: Dict, payload: str) -> None:
    logging.debug('push to hec with url=%s headers=%s payload=%s', url, headers, payload)
    response = requests.post(url=url, headers=headers, data=payload)
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
    logging.error('Failed before pushing events. err: %s events: %s', exception, events)
    event_body_list = []
    for event in events:
        event_body = event.get_body()
        event_body_list.append(event_body)

    event_body_output = b'%s' % (b'\n'.join(event_body_list))
    output_blob.set(event_body_output)


def handle_push_exceptions(failed_requests: list, output_blob: func.Out[bytes]) -> None:
    if not failed_requests:
        return
    output_string = '\n'.join(failed_requests)
    output_blob.set(output_string)
