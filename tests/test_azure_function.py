"""Copyright (c) 2021 Splunk, Inc. All rights reserved."""
from unittest.mock import call, patch

import os

import requests

from base_azure_function_test_case import BaseAzureFunctionTestCase, MockBlobStore


MOCK_ENV = {
    'HecUrl': 'mock://hec:url',
    'HecToken': 'mock_hec_token',
    'SourceType': 'mock_sourcetype',
    'Region': 'mock_region',
    # The namespace can contain only letters, numbers, and hyphens. The namespace must start with a
    # letter, and it must end with a letter or number.
    'EventHubConnection': "key1=val;Endpoint=sb://Mock-0-Namespace1.servicebus.windows.net/;key2=v",
    'EventHubName': 'mock-eh-name',
}
MOCK_GOOD_RESPONSE = requests.Response()
MOCK_GOOD_RESPONSE.status_code = 200
MOCK_BAD_RESPONSE = requests.Response()
MOCK_BAD_RESPONSE.status_code = 500


class TestAzureFunction(BaseAzureFunctionTestCase):
    @patch('requests.post')
    def test_push_simple_event(self, post):
        post.return_value = MOCK_GOOD_RESPONSE
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, MOCK_ENV):
            self.run_func(log_lists, MockBlobStore())

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
        post.return_value = MOCK_GOOD_RESPONSE
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

        with patch.dict(os.environ, MOCK_ENV):
            self.run_func(log_lists, MockBlobStore())

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

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_events_on_global_exception(self, blob_set, post):
        post.return_value = MOCK_GOOD_RESPONSE
        log_lists = [[{'Foo': 'bar'}]]

        # Do not mock env vars so to trigger exception on payloads preparation.
        self.run_func(log_lists, MockBlobStore())

        post.assert_not_called()
        blob_set.assert_called_once_with(b'prepush exception; need to save all events')

    # Do not mock post() so to trigger exception on it.
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_events_on_general_push_exception(self, blob_set):
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, MOCK_ENV):
            self.run_func(log_lists, MockBlobStore())

        expected_msg = b'push exception; need to save current payload and request/response info'
        blob_set.assert_called_once_with(expected_msg)

    @patch('requests.post')
    @patch('base_azure_function_test_case.MockBlobStore.set')
    def test_save_events_on_hec_bad_response(self, blob_set, post):
        post.return_value = MOCK_BAD_RESPONSE
        log_lists = [[{'Foo': 'bar'}]]

        with patch.dict(os.environ, MOCK_ENV):
            self.run_func(log_lists, MockBlobStore())

        expected_msg = b'push exception; need to save current payload and request/response info'
        blob_set.assert_called_once_with(expected_msg)
