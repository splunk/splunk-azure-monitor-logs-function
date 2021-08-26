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

from unittest.mock import patch

import os

import common
from base_azure_function_test_case import BaseAzureFunctionTestCase, MockBlobStore


class TestFailedEventHandling(BaseAzureFunctionTestCase):
    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_events_on_global_exception(self, blob_set, post):
        post.return_value = common.MOCK_GOOD_RESPONSE
        log_lists = [
            [
                {
                    'Foo': 'from_msg1',
                },
                {
                    'Foo': 'from_msg2',
                }
            ]
        ]

        expected_response = b'{"records":[{"Foo":"from_msg1"},{"Foo":"from_msg2"}]}'

        # Do not mock env vars so to trigger exception on payloads preparation.
        self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        post.assert_not_called()
        blob_set.assert_called_once_with(expected_response)

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_multiple_events_on_global_exception(self, blob_set, post):
        post.return_value = common.MOCK_GOOD_RESPONSE
        log_lists = [
            [
                {
                    'Foo': 'event1_from_msg1',
                },
                {
                    'Foo': 'event1_from_msg2',
                }
            ],
            [
                {
                    'Foo': 'event2_from_msg1',
                }
            ]
        ]

        expected_response = b'{"records":[{"Foo":"event1_from_msg1"},{"Foo":"event1_from_msg2"}]}' \
                            b'\n{"records":[{"Foo":"event2_from_msg1"}]}'

        # Do not mock env vars so to trigger exception on payloads preparation.
        self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        post.assert_not_called()
        blob_set.assert_called_once_with(expected_response)

    # Do not mock post() so to trigger exception on it.
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_events_on_general_push_exception(self, blob_set):
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        expected_msg = '{"event":{"Foo":"bar","data_manager_input_id":"mock-input-id"},' \
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"' \
                        ',"sourcetype":"mock_sourcetype"}'
        blob_set.assert_called_once_with(expected_msg)

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_batch_on_hec_bad_response(self, blob_set, post):
        post.return_value = common.MOCK_BAD_RESPONSE
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        expected_msg = '{"event":{"Foo":"bar","data_manager_input_id":"mock-input-id"},' \
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"' \
                        ',"sourcetype":"mock_sourcetype"}'
        blob_set.assert_called_once_with(expected_msg)

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    @patch('azure_monitor_logs_processor_func.SPLUNK_BATCH_MAX_SIZE_BYTES', 1)
    def test_save_multiple_batches_on_hec_bad_response(self, blob_set, post):
        post.return_value = common.MOCK_BAD_RESPONSE
        log_lists = [
            [
                {
                    'Foo': 'from_msg1',
                },
            ],
            [
                {
                    'Foo': 'from_msg2',
                },
            ],
        ]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        expected_msg = '{"event":{"Foo":"from_msg1","data_manager_input_id":"mock-input-id"},'\
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",'\
                        '"sourcetype":"mock_sourcetype"}\n'\
                        '{"event":{"Foo":"from_msg2","data_manager_input_id":"mock-input-id"},'\
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",'\
                        '"sourcetype":"mock_sourcetype"}'
        blob_set.assert_called_once_with(expected_msg)

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    @patch('azure_monitor_logs_processor_func.SPLUNK_BATCH_MAX_SIZE_BYTES', 1)
    def test_save_select_batches_on_select_hec_bad_responses(self, blob_set, post):
        post.side_effect = [common.MOCK_BAD_RESPONSE, common.MOCK_GOOD_RESPONSE]
        log_lists = [
            [
                {
                    'Foo': 'from_msg1',
                },
            ],
            [
                {
                    'Foo': 'from_msg2',
                },
            ],
        ]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        expected_msg = '{"event":{"Foo":"from_msg1","data_manager_input_id":"mock-input-id"},' \
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"' \
                        ',"sourcetype":"mock_sourcetype"}'
        blob_set.assert_called_once_with(expected_msg)
