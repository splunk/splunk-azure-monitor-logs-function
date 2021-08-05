"""Copyright (c) 2021 Splunk, Inc. All rights reserved."""
import json
import logging
import os
import re
from typing import Dict
from typing import List

import azure.functions as func
import pandas as pd
import requests


INVALID_TIMESTAMP = -1


def main(events: List[func.EventHubEvent], failedEventsOutputBlob: func.Out[bytes]):  # pylint: disable=invalid-name
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
        handle_prepush_exception(err, events, failedEventsOutputBlob)
        return

    for payload in payloads:
        try:
            push_to_hec(url, headers, payload)
        except Exception as err:  # pylint: disable=broad-except
            handle_push_exception(err, url, headers, payload, failedEventsOutputBlob)


def build_payloads(events: List[func.EventHubEvent]) -> List[str]:
    payloads = []
    for event in events:
        payload = ''
        event_body = event.get_body()
        logging.debug('processing event:%s', event_body)
        event_json = json.loads(event_body)
        logs = event_json.get('records')
        for log in logs:
            splunk_event = to_splunk_event(log)
            payload += json.dumps(splunk_event, separators=(',', ':'))
        payloads.append(payload)

    return payloads


def push_to_hec(url: str, headers: Dict, payload: str) -> None:
    logging.debug('push to hec with url=%s headers=%s payload=%s', url, headers, payload)
    response = requests.post(url=url, headers=headers, data=payload)
    if not response.ok:
        raise Exception('HEC push failed. code:%s msg:%s' % (response.status_code, response.text))


def to_splunk_event(log: Dict) -> Dict:
    output = {
        'event': log,
        'source': get_source(),
        'sourcetype': os.environ["SourceType"],
    }
    timestamp = extract_timestamp(log)
    if timestamp >= 0:
        output['time'] = timestamp

    return output


def get_source() -> str:
    region = os.environ["Region"]
    eventhub_connection = os.environ["EventHubConnection"]
    regex = r'.*Endpoint=sb://(.+)\.servicebus\.windows\.net.*'
    match = re.compile(regex).match(eventhub_connection)
    eventhub_namespace = match.group(1)
    eventhub_name = os.environ["EventHubName"]

    return 'azure:%s:%s:%s' % (region, eventhub_namespace, eventhub_name)


def extract_timestamp(log: Dict) -> int:
    time_str = log.get('Time')
    if not time_str:
        logging.debug('no time field:%s', log)
        return INVALID_TIMESTAMP

    try:
        timestamp = pd.to_datetime(time_str).value
    except Exception:  # pylint: disable=broad-except
        logging.debug('unable to parse timestamp:%s', time_str)
        return INVALID_TIMESTAMP

    return timestamp


def handle_prepush_exception(exception: Exception, events: List[func.EventHubEvent],  # pylint: disable=invalid-name
                            failedEventsOutputBlob: func.Out[bytes]) -> None:
    """to be implemented; current only a stub"""
    stub_backup_msg = b'prepush exception; need to save all events'
    # Save all original events payloads are not ready yet.
    failedEventsOutputBlob.set(stub_backup_msg)
    logging.error('%s%s', exception, events)


def handle_push_exception(exception: Exception, url: str, headers: Dict, payload: str,  # pylint: disable=invalid-name
                          failedEventsOutputBlob: func.Out[bytes]) -> None:
    """to be implemented; current only a stub"""
    stub_backup_msg = b'push exception; need to save current payload and request/response info'
    failedEventsOutputBlob.set(stub_backup_msg)
    logging.error('%s%s%s%s', exception, url, headers, payload)
