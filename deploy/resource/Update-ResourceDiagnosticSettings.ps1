<#PSScriptInfo

.VERSION 1.0

.GUID D14FA91F-3B32-4164-8634-8616197412C6

.AUTHOR Splunk, Inc.

.COMPANYNAME Splunk, Inc.

.COPYRIGHT
Copyright 2022 Splunk, Inc.

Licensed under the Apache License, Version 2.0 (the "License"): you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations
under the License.

.LICENSEURI http://www.apache.org/licenses/LICENSE-2.0

.PROJECTURI https://github.com/splunk/splunk-azure-monitor-logs-function/

.EXTERNALMODULEDEPENDENCIES AZ
#>

<#
.SYNOPSIS
    For a given SCDM input, this script creates diagnostic settings on
    resource ids passed in. 

.PARAMETER ResourcesToEnableDiagnosticSettings
    A list of resource IDs that should have diagnostic settings created on
    by the end of the script.

.PARAMETER SCDMInputId
    The ID of the SCDM input.

.PARAMETER EventHubName
    The name of the Event Hub that logs should be sent to. Defaults to
    'splk-resource-logs-eventhub'.

.PARAMETER EventHubAuthRuleId
    The fully qualified id of the Event Hub authorization rule. If not passed
    in, 'DestinationSubscriptionId' is required and the value gets derived as "/subscriptions/${DestinationSubscriptionId}/resourceGroups/SplunkDMDataIngest-${SCDMInputId}/providers/Microsoft.EventHub/namespaces/splkResLogsEH${SCDMInputId}/authorizationRules/splk-resource-logs-eventhub-auth-send"

.PARAMETER DestinationSubscriptionId
    The ID of the subscription where the destination Event Hub namespace lives.
    It will be used to derive the authorization rule id if EventHubAuthRuleId
    is not passed in.

.PARAMETER TenantId
    The ID of the tenant the script is running under. Used to list
    subscriptions.

.PARAMETER ExistingResourceGroupName
    The name of an existing resource group in Azure that the resources will be deployed to. Used to infer the EventHubAuthRuleId

.EXAMPLE
    The example below creates a diagnostic setting on an Azure function resource.
    ./Update-ResourceDiagnosticSettings.ps1 `
        -ResourcesToEnableDiagnosticSettings @('/subscriptions/c83c2282-2e21-4f64-86ae-fdfa66b673eb/resourceGroups/SplunkDMDataIngest-3da4204b-9293-42eb-997b-819bb5a4dfef/providers/Microsoft.Web/sites/splkResLogsFn3da4204b-9293-42eb-997b-819bb5a4dfef') `
        -SCDMInputId 3da4204b-9293-42eb-997b-819bb5a4dfef `
        -TenantId 501792f2-ef2c-4251-957b-293fadb63ddc `
        -DestinationSubscriptionId c83c2282-2e21-4f64-86ae-fdfa66b673eb

#>
param (
    [Parameter(Mandatory = $true)]
    [string[]] $ResourcesToEnableDiagnosticSettings,
    [Parameter(Mandatory = $true)]
    [string] $SCDMInputId,
    [Parameter(Mandatory = $false)]
    [string] $EventHubName = "splk-resource-logs-eventhub",
    [Parameter(Mandatory = $true, ParameterSetName = "EventHubAuthRuleIdOverride")]
    [string] $EventHubAuthRuleId,
    [Parameter(Mandatory = $true, ParameterSetName = "DeriveEventHubAuthRuleId")]
    [string] $DestinationSubscriptionId,
    [Parameter(Mandatory = $false, ParameterSetName = "DeriveEventHubAuthRuleId")]
    [string] $ExistingResourceGroupName="SplunkDMDataIngest-${SCDMInputId}",
    [Parameter(Mandatory = $true)]
    [string] $TenantId
)

# Infer EventHubAuthRuleId if required
if ($PSBoundParameters.ContainsKey('DestinationSubscriptionId')) {
    $EventHubAuthRuleId = "/subscriptions/${DestinationSubscriptionId}/resourceGroups/${ExistingResourceGroupName}/providers/Microsoft.EventHub/namespaces/splkResLogsEH${SCDMInputId}/authorizationRules/splk-resource-logs-eventhub-auth-send"
    Write-Host "Using Event Hub authorization rule id '${EventHubAuthRuleId}'"
}

function Set-DiagnosticSetting {
    param (
        $ResourceIdToEnableDiagSetting
    )
    Write-Host "Creating and setting diagnostic setting on resource '${ResourceIdToEnableDiagSetting}'"

    $diagnosticSettingName = "splunk-resource-logs-" + $SCDMInputId

    Set-AzDiagnosticSetting -ResourceId $ResourceIdToEnableDiagSetting `
        -Name $diagnosticSettingName `
        -EnableLog $True `
        -EventHubName $EventHubName `
        -EventHubAuthorizationRuleId $EventHubAuthRuleId `
        -WarningAction Ignore

    Write-Host "Finished creating and setting diagnostic setting for resource '${ResourceIdToEnableDiagSetting}'"
}

try {
    foreach ($resourceId in $ResourcesToEnableDiagnosticSettings) {
        Set-DiagnosticSetting -ResourceIdToEnableDiagSetting $resourceId
    }
}
catch {
    Write-Error -Message "There was an error updating diagnostic settings. Please resolve the problem and retry."
    Write-Error -Exception $PSItem.Exception
}