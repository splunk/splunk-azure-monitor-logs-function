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

import unittest

import json
from typing import Dict, List, Union

import azure.functions as func
from azure_monitor_logs_processor_func import main


class BaseAzureFunctionTestCase(unittest.TestCase):
    """Base class for common test workflows."""

    def test_logs_to_eventhub_events(self):
        log_lists = [
            [
                {
                    'time': '1',
                },
                {
                    'time': 2,
                },
            ],
            [
                {
                    'time': '3',
                },
                {
                    # After serialized to json, single/double quote shouldn't matter.
                    "time": "4",
                },
            ],
        ]

        events = self.logs_to_eventhub_events(log_lists)

        self.assertEqual(len(events), 2)
        body0 = events[0].get_body().decode('utf-8')
        expected0 = '{"records":[{"time":"1"},{"time":2}]}'
        self.assertEqual(body0, expected0)
        body1 = events[1].get_body().decode('utf-8')
        expected1 = '{"records":[{"time":"3"},{"time":"4"}]}'
        self.assertEqual(body1, expected1)

    @staticmethod
    def logs_to_eventhub_events(log_lists: List[List[Dict]]):
        """Convert json logs as a 2D list to a list of Eventhub events that can be used as input to
        Azure function.

        A helper for developers to specify test payload as python native data structures rather than
        plain text.
        """
        events = []
        for log_list in log_lists:
            event = {
                'records': log_list,
            }
            event = json.dumps(event, separators=(',', ':'))
            event = str.encode(event)
            event = func.EventHubEvent(body=event)
            events.append(event)

        return events

    def run_func(self, log_lists: List[List[Dict]],
                 failed_parse_events_output_blob: func.Out[bytes],
                 failed_send_events_output_blob: func.Out[bytes]):
        """Run Azure function with Eventhub events constructed from log_lists."""
        events = self.logs_to_eventhub_events(log_lists)
        main(events, failed_parse_events_output_blob, failed_send_events_output_blob)


class MockBlobStore(func.Out):
    def set(self, val: Union[bytes, str]) -> None:
        pass

    def get(self) -> bytes:
        pass
