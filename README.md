# Azure Monitor Logs Azure Function

## Setting up Dev Environment
### Install tools
1. Azure Functions Core Tools. Install v3
   * https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local?tabs=macos%2Ccsharp%2Cbash#v3
1. Azure CLI
   * https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
   * Run `az login` after installation complete
1. Make sure you have Python 3.7.x and then run
   * `> python -m venv .venv` 
   * `> source .venv/bin/activate` 
   * If you're on Linux and Python didn't install the venv package, run `sudo apt-get install python3-venv`

### Local config
Create a file named `local.settings.json` at the root of the repository and fill in the appropriate values. The values 
get set as environment variables on the function, which then the function can read.

Additionally, the values can be referenced in `azure_monitor_logs_processor_func/function.json` by their names and 
surrounding them with a `%`. For example, `%EventHubConnection%`.

#### Template
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "AzureWebJobsStorage": "",
    "FailedEventsStorageConnection": "",
    "EventHubConnection":"",
    "HecUrl": "",
    "SourceType": "",
    "Region":"",
    "ConsumerGroupName": "",
    "EventHubName": "",
    "LogLevel": ""
  }
}
```
#### Config values
- **AzureWebJobsStorage** Connection string to a storage account for Azure Function runtime storage. Can be the same as 
FailedEventsStorageConnection
- **FailedEventsStorageConnection** Connection string to storage account where failed events will be saved. 
  [Azure Function output binding for storage configuration docs](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-blob-output?tabs=python#configuration)
  [Storage docs](https://docs.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string)
- **EventHubConnection** Connection string to the EventHub *namespace* to read from. 
  [Azure Function trigger for EvenHubs configuration docs](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-event-hubs-trigger?tabs=python#configuration). 
  [EventHub docs](https://docs.microsoft.com/en-us/azure/event-hubs/event-hubs-get-connection-string).
- **HecUrl** The HEC URL to where events should be sent, ex. `https://http-inputs-tenant-name.env.splunkcloud.com:443`. See [Splunk HEC documentation](https://docs.splunk.com/Documentation/Splunk/8.2.1/Data/UsetheHTTPEventCollector) for details. Do not include `/<endpoint>` since the function needs to specify it. Equivalent to the `Splunk HEC URL` parameter in [Splunk Dataflow template](https://cloud.google.com/blog/products/data-analytics/connect-to-splunk-with-a-dataflow-template). 
- **HecToken** The HEC Token associated with `HecUrl`, ex. `X99XXXXX-111X-222X-X333-XX789X789X789X`.  
- **SourceType** The `sourcetype` this function will set on each ingested log and used to build the path of the file 
  containing failed to deliver logs, ex. `azure:aad`, `azure:activity`, or `azure:resource`
- **Region** The region this function will set on each ingested log and used for path of failed to deliver logs, ex. 
  `useast1`
- **ConsumerGroupName** The name of the EventHub consumer group. https://docs.microsoft.com/en-us/azure/event-hubs/event-hubs-features#event-consumers
- **EventHubName** The name of the EventHub to receive logs from. This has a one-to-one mapping to sourcetype. ex. 
  EventHub name of `aad-logs` for `azure:aad`, `activity-logs` for `azure:activity`, or `resource-logs` for `azure:resource`
- **LogLevel** The function logging level in the standard python level name format, ex. `DEBUG`. If not set, defaults to `INFO`.


### Run
```bash
> pip install -r requirements.txt
> func start
```

### Run tests
From project root:
```bash
> pip install pytest
> python -m pytest tests
```

### Deploy
See [documentation](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local?tabs=windows%2Ccsharp%2Cportal%2Cbash%2Ckeda#publish). 

Make sure to set up environment variables before the first push or when they change with one the options:
- include `--publish-local-settings` in the push command

OR

- set `local.settings.json` values in "Settings->Configuration->Application settings" of the Function App in portal


## How this project was created
```bash
> func init azure_monitor_logs_processor_func --python
> cd azure_monitor_logs_processor_func
> func new --name azure_monitor_logs_processor_func --template "Azure Event Hub trigger" --cadinality "many" --connection "EVENTHUB_CONNECTION_STRING" --consumerGroup "splunk-consumer-group" --dataType "string"
```
After being initialized in that manner, an additional output binding for blob storage was added in `function.json`.

## Enabling Debug Logging
In `host.json`, set `logging.logLevel.default` to `DEBUG` and environment variable `LogLevel` to `DEBUG`.
> For more info, see https://github.com/Azure/azure-functions-python-worker/issues/248