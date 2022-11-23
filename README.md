# Azure Monitor Logs Azure Function
This function receives data from an Azure Event Hub, parses the messages, and sends the Azure Monitor logs via HEC to the Splunk Platform where they are indexed.

This repository also includes
* ARM templates to deploy the required Azure resources, including the Azure Function, that send logs to Splunk for the Splunk Cloud Data Manager application
* PowerShell scripts that enable diagnostic settings on Azure resources

## Set up the Dev Environment
Ideally, you should be setting up this repository during [the onboarding process](https://splunk.atlassian.net/wiki/spaces/PROD/pages/1078171273052/Engineer+Onboarding+-+Azure+Push-based) for full context:
### Install tools
1. Azure Functions Core Tools (Install latest version).
   * https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local?tabs=v4%2Cmacos%2Ccsharp%2Cportal%2Cbash#v4
2. Azure CLI.
   * https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
   * Run `az login` after installation complete
3. Powershell (Install latest version).

   https://docs.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-macos?view=powershell-7.2
   
   Needed modules in Powershell
   * Run `Install-Module -Name Pester` (unit tests)
   * Run `Install-Module -Name Az -AllowClobber -Scope CurrentUser`
4. Make sure you have Node 16.
   
   To be compatible with other repositories using different version of Node, it is recommended to use [Node Version Manager](https://github.com/nvm-sh/nvm)
   ```bash
   nvm install 16
   nvm use 16
   ```
### Local configuration
Create a file named `local.settings.json` at the root of the repository and fill in the appropriate values. The values
get set as environment variables in the function.

These settings can be referenced in `azure_monitor_logs_processor_func/function.json` by their names
surrounded with `%` symbols. For example, `%EventHubConnection%`.

#### Template
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
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
#### Required arguments
- **AzureWebJobsStorage**: Connection string for the account where Azure Function runtime data is stored. This value can be the same as FailedEventsStorageConnection.
- **FailedEventsStorageConnection**: Connection string for the account where failed events are stored.
  See [Azure Function output binding for storage configuration](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-blob-output?tabs=javascript#configuration) and [Configure Azure Storage connection strings](https://docs.microsoft.com/en-us/azure/storage/common/storage-configure-connection-string) in the Microsoft Azure documentation.
- **EventHubConnection**: Connection string for the EventHub *namespace*. See [Azure Event Hubs trigger for Azure Functions](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-event-hubs-trigger?tabs=javascript#configuration) and [Get an Event Hubs connection string](https://docs.microsoft.com/en-us/azure/event-hubs/event-hubs-get-connection-string) in the Microsoft Azure documentation.
- **HecUrl**: The HEC URL that events are sent to. For example, `https://http-inputs-tenant-name.env.splunkcloud.com:443`. See [Set up and use HTTP Event Collector in Splunk Web](https://docs.splunk.com/Documentation/Splunk/8.2.1/Data/UsetheHTTPEventCollector) for details. Do not include `/<endpoint>` in the HEC URI because this is set by the function and not configurable. This argument is equivalent to `Splunk HEC URL` in the [Splunk Dataflow template](https://cloud.google.com/blog/products/data-analytics/connect-to-splunk-with-a-dataflow-template).
- **HecToken**: The HEC Token associated with `HecUrl`. For example, `X99XXXXX-111X-222X-X333-XX789X789X789X`.
- **SourceType**: The `sourcetype` set on each ingested log. For example, `azure:monitor:aad`, `azure:monitor:activity`, or `azure:monitor:resource`. This argument is also for the path to the file containing the logs that could not be delivered.
- **Region**: The region this function sets on each ingested log. For example, `useast1`. This argument is also used for the path to the file containing the logs that could not be delivered.
- **ConsumerGroupName**: The name of the EventHub consumer group. See [Event consumers](https://docs.microsoft.com/en-us/azure/event-hubs/event-hubs-features#event-consumers) in the Microsoft Azure documentation.
- **EventHubName**: The name of the EventHub to receive logs from. This has a one-to-one mapping to sourcetype. For example, EventHub name of `aad-logs` for `azure:monitor:aad`, `activity-logs` for `azure:monitor:activity`, or `resource-logs` for `azure:monitor:resource`
- **DataManagerInputId**: The ID of the Splunk Cloud Data Manager input. For example, `X99XXXXX-111X-222X-X333-XX789X789X789X`.

### Install Dependencies
Required first time and whenever you change package.json.
```bash
npm install
```
### Build and run
```bash
npm run start
```

### Run tests
#### Azure Function Tests
From the project root:
```bash
npm test
```

#### ARM Template Tests
Tests for ARM templates need to be run in Powershell.

Run validation and unit tests on ARM templates from the project root:

```powershell
Connect-AzAccount -Tenant '<your-tenant-id>'
Import-Module ./Test-ARMTemplates.ps1
Test-ARMTemplates -TemplateFolder ./deploy -UnitTest
```

Run individual test script file from deployment tests directory:
```powershell
$container = New-PesterContainer -Path <test file> -Data @{ SCDMInputId=<SCDMId> }
$testResult = Invoke-Pester -Container $container
```

### Deploy
See [Publish to Azure](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local?tabs=windows%2Ccsharp%2Cportal%2Cbash%2Ckeda#publish) in the Microsoft Azure documentation.

Make sure you set up the environment variables before the first push or when they change with one of the following options.

- Include `--publish-local-settings` in the push command.

OR

- Set the `local.settings.json` values for the Function App in the Microsoft Azure portal at "Settings -> Configuration -> Application settings".


## How this project was created
```bash
> func init azure-monitor-logs-azure-function --typescript
> cd azure-monitor-logs-azure-function
> func new --name azure_monitor_logs_processor_func --template "Azure Event Hub trigger" --cadinality "many" --connection "EVENTHUB_CONNECTION_STRING"
```
After being initialized, an additional output binding for blob storage was added in `function.json`.

## Enabling Verbose Logging
In `host.json`, set `logging.logLevel.Function` to `Trace` to enable verbose logging just for this Azure Function code.
For more logging options for other components, see [Configure log levels](https://docs.microsoft.com/en-us/azure/azure-functions/configure-monitoring?tabs=v2#configure-log-levels) in the Microsoft Azure documentation.

## Appendix
### Setup Azure dev account
Ask to be added to `CDC TEAM` Azure directory (splunkcdcdev.onmicrosoft.com). 
You will also need to be made a global admin (for AAD diagnostics settings) and owner of subscriptions (for acivity logs, diagnostics settings on subscriptions).