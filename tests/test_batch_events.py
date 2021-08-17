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
from typing import List
from unittest.mock import patch

from azure_monitor_logs_processor_func import batch_events


@patch('azure_monitor_logs_processor_func.SPLUNK_BATCH_MAX_SIZE_BYTES', 3)
class TestBatchEvents(unittest.TestCase):
    """Class for testing batching of splunk events."""

    def test_batch_events_zero_logs_zero_batches(self):
        events = []
        self.assertEqual([], batch_events(events))

    def test_batch_events_single_log_fit_in_single_batch(self):
        events = create_events(count=1, size=1)
        self.assertEqual(['a'], batch_events(events))

    def test_batch_events_single_log_fit_exactly_in_single_batch(self):
        events = create_events(count=1, size=3)
        self.assertEqual(['aaa'], batch_events(events))

    def test_batch_events_single_too_large_log_fit_in_single_batch(self):
        events = create_events(count=1, size=4)
        self.assertEqual(['aaaa'], batch_events(events))

    def test_batch_events_multiple_logs_fit_in_single_batch(self):
        events = create_events(count=2, size=1)
        self.assertEqual(['aa'], batch_events(events))

    def test_batch_events_multiple_logs_fit_exactly_in_single_batch(self):
        events = create_events(count=3, size=1)
        self.assertEqual(['aaa'], batch_events(events))

    def test_batch_events_multiple_logs_overflows_to_two_batches(self):
        events = create_events(count=4, size=1)
        self.assertEqual(['aaa', 'a'], batch_events(events))

    def test_batch_events_multiple_logs_overflows_to_three_batches(self):
        events = create_events(count=9, size=1)
        self.assertEqual(['aaa', 'aaa', 'aaa'], batch_events(events))

    def test_batch_events_multiple_logs_first_large_others_not_overflows(self):
        events = create_events(count=1, size=4)
        events.extend(create_events(count=3, size=1))
        self.assertEqual(['aaaa', 'aaa'], batch_events(events))

    def test_create_event(self):
        event = create_event(3)
        self.assertEqual(3, len(event))

    def create_events(self):
        events = create_events(count=3, size=3)
        self.assertEqual(3, len(events))
        for event in events:
            self.assertEqual(3, len(event))


def create_event(size) -> str:
    return 'a' * int(size)


def create_events(count, size) -> List[str]:
    return count * [create_event(size)]
