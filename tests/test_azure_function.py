"""Copyright (c) 2021 Splunk, Inc. All rights reserved."""
from unittest.mock import call, patch

import os

import common
from base_azure_function_test_case import BaseAzureFunctionTestCase, MockBlobStore


class TestAzureFunction(BaseAzureFunctionTestCase):
    @patch('requests.post')
    def test_push_simple_event(self, post):
        post.return_value = common.MOCK_GOOD_RESPONSE
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        expected_url = "mock://hec:url/services/collector/event"
        expected_headers = {
            'Authorization': 'Splunk mock_hec_token',
        }
        expected_data = '{"event":{"Foo":"bar"},' \
                        '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",' \
                        '"sourcetype":"mock_sourcetype"}'
        post.assert_called_once_with(url=expected_url, headers=expected_headers, data=expected_data)

    @patch('requests.post')
    @patch('azure_monitor_logs_processor_func.SPLUNK_BATCH_MAX_SIZE_BYTES', 240)
    def test_batching(self, post):
        post.return_value = common.MOCK_GOOD_RESPONSE
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
                {
                    'Foo': 'from_msg2',
                },
            ],
        ]

        with patch.dict(os.environ, common.MOCK_ENV):
            self.run_func(log_lists, MockBlobStore(), MockBlobStore())

        self.assertEqual(2, post.call_count)
        expected_url = "mock://hec:url/services/collector/event"
        expected_headers = {
            'Authorization': 'Splunk mock_hec_token',
        }
        expected_data1 = '{"event":{"Foo":"from_msg1"},' \
                         '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",' \
                         '"sourcetype":"mock_sourcetype"}' \
                         '{"event":{"Foo":"from_msg2"},' \
                         '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",' \
                         '"sourcetype":"mock_sourcetype"}'
        expected_data2 = '{"event":{"Foo":"from_msg2"},' \
                         '"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name",' \
                         '"sourcetype":"mock_sourcetype"}'
        call1 = call(url=expected_url, headers=expected_headers, data=expected_data1)
        call2 = call(url=expected_url, headers=expected_headers, data=expected_data2)
        calls = [call1, call2]
        post.assert_has_calls(calls)
