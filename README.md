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
Create a file named `local.settings.json` at the root of the repository and fill in the appropriate values.
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "AzureWebJobsStorage": "--Connection string to a storage account for Azure Function runtime storage. Can be the same as FailedEventsStorageConnection.--",
    "FailedEventsStorageConnection": "--Connection string to storage account where failed events will be saved.--",
    "EventHubConnection":"--Connection string to EventHub to read from, format Endpoint=sb://{event-hub-namespace}.servicebus.windows.net/;SharedAccessKeyName={name};SharedAccessKey={key};EntityPath={event-hub-name}--",
    "SourceType":"--The sourcetype this function will set on each ingested log and used for path of failed to deliver logs, ex. 'azure:aad', 'azure:activity', or 'azure:resource'--",
    "Region":"--The region this function will set on each ingested log and used for path of failed to deliver logs, ex. useast1--",
    "EventHubName": "--The name of the event hub that triggers this function. ex. 'aad-logs', 'activity-logs', or 'resource-logs'--"
  }
}
```

### Run
```bash
> func start
```

### Run tests
From project root:
```bash
> python -m pytest tests
```

## How this project was created
```bash
> func init azure_monitor_logs_processor_func --python
> cd azure_monitor_logs_processor_func
> func new --name azure_monitor_logs_processor_func --template "Azure Event Hub trigger" --cadinality "many" --connection "EVENTHUB_CONNECTION_STRING" --consumerGroup "splunk-consumer-group" --dataType "string"
```
After being initialized in that manner, an additional output binding for blob storage was added in `function.json`.