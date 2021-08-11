"""Copyright (c) 2021 Splunk, Inc. All rights reserved."""
import requests

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
