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
