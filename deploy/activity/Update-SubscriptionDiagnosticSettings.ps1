<#PSScriptInfo

.VERSION 1.0

.GUID 7AB9ACA9-A1CA-4214-B030-84A8403364B2

.AUTHOR Splunk, Inc.

.COMPANYNAME Splunk, Inc.

.COPYRIGHT
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

.LICENSEURI http://www.apache.org/licenses/LICENSE-2.0

.PROJECTURI https://github.com/splunk/splunk-azure-monitor-logs-function/

.EXTERNALMODULEDEPENDENCIES AZ
#>

<#
.SYNOPSIS
    For a given SCDM input, this script creates diagnostic settings on
    subscriptions passed in on the tenant. It also disables diagnostic
    settings on all other subscriptions in the tenant.

.DESCRIPTION
    It first lists all subscriptions the current context has access to. It then
    creates diagnostic settings on all subscriptions in
    SubscriptionsThatMustHaveDiagnosticSettings if they don't already have it
    created. It identifies diagnostic settings for specific SCDM inputs by
    giving them a name with the SCDM input id as the suffix.

    For all other subscriptions that the current context has access to and are
    not included in SubscriptionsThatMustHaveDiagnosticSettings, the script
    disables the SCDM specific diagnostic settings if they are present.

.PARAMETER SubscriptionsThatMustHaveDiagnosticSettings
    A list of subscription IDs that should have diagnostic settings created on
    by the end of the script. All other subscriptions should have diagnostic
    settings deleted for given SCDM input id.

.PARAMETER SCDMInputId
    The ID of the SCDM input.

.PARAMETER EventHubName
    The name of the Event Hub that logs should be sent to. Defaults to
    'splk-activity-logs-eventhub'.

.PARAMETER EventHubAuthRuleId
    The fully qualified id of the Event Hub authorization rule. If not passed
    in, 'DestinationSubscriptionId' is required and the value gets derived as "/subscriptions/${DestinationSubscriptionId}/resourceGroups/SplunkDMDataIngest-${SCDMInputId}/providers/Microsoft.EventHub/namespaces/splkActLogsEH${SCDMInputId}/authorizationRules/splk-activity-logs-eventhub-auth-send"

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
    The example below creates a diagnostic setting on
    'c18feaec-82a8-41a8-a774-0ccf3f851e95', and
    '18b2f97d-66ec-4c61-a40c-bfed5110f38e', and deletes all other diagnostic
    settings on subscriptions in Tenant '9078fc2c-4e34-483c-abed-f8b139ab37d9'.
    PS C:\> ./Update-SubscriptionDiagnosticSettings.ps1 `
        -SubscriptionsThatMustBeEnabled @('c18feaec-82a8-41a8-a774-0ccf3f851e95', '18b2f97d-66ec-4c61-a40c-bfed5110f38e') `
        -SCDMInputId 7402daec-f1e3-439e-9ccb-1ff0a867ff41 `
        -TenantId 9078fc2c-4e34-483c-abed-f8b139ab37d9 `
        -DestinationSubscriptionId 1dfeb2ca-3f59-4dc8-abaf-63ba63a6f429

    The example below deletes all diagnostic settings on subscriptions in
    Tenant '9078fc2c-4e34-483c-abed-f8b139ab37d9'.
    PS C:\> ./Update-SubscriptionDiagnosticSettings.ps1 `
        -SubscriptionsThatMustBeEnabled @() `
        -SCDMInputId 7402daec-f1e3-439e-9ccb-1ff0a867ff41 `
        -TenantId 9078fc2c-4e34-483c-abed-f8b139ab37d9 `
        -DestinationSubscriptionId 1dfeb2ca-3f59-4dc8-abaf-63ba63a6f429
#>

param (
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]] $SubscriptionsThatMustHaveDiagnosticSettings,
    [Parameter(Mandatory = $true)]
    [string] $SCDMInputId,
    [Parameter(Mandatory = $false)]
    [string] $EventHubName = "splk-activity-logs-eventhub",
    [Parameter(Mandatory = $true, ParameterSetName = "EventHubAuthRuleIdOverride")]
    [string] $EventHubAuthRuleId,
    [Parameter(Mandatory = $true, ParameterSetName = "DeriveEventHubAuthRuleId")]
    [string] $DestinationSubscriptionId,
    [Parameter(Mandatory = $false, ParameterSetName = "DeriveEventHubAuthRuleId")]
    [string] $ExistingResourceGroupName="SplunkDMDataIngest-${SCDMInputId}",
    [Parameter(Mandatory = $true)]
    [string] $TenantId
)

function Set-DiagnosticSetting {
    param (
        $SubscriptionIdToEnableDiagSetting
    )
    Write-Host "Creating and setting diagnostic setting on subscription '${SubscriptionIdToEnableDiagSetting}'"

    New-AzSubscriptionDiagnosticSetting `
        -Name $diagnosticSettingName `
        -SubscriptionId $SubscriptionIdToEnableDiagSetting `
        -EventHubAuthorizationRuleId $EventHubAuthRuleId `
        -EventHubName $EventHubName `
        -Log $subscriptionLogSettingsObjects

    Write-Host "Finished creating and setting diagnostic setting for subscription '${SubscriptionIdToEnableDiagSetting}'"
}

function Remove-DiagnosticSetting {
    [CmdletBinding()]
    param (
        $SubscriptionIdToRemoveDiagSetting
    )
    Write-Host "Removing diagnostic setting from subscription '${SubscriptionIdToRemoveDiagSetting}'."

    if (!(Get-DiagnosticSettingExists -SubscriptionId $SubscriptionIdToRemoveDiagSetting)) {
        Write-Host "Setting does not exist. Skipping removal of the diagnostic setting from subscription '${SubscriptionIdToRemoveDiagSetting}'."
        return;
    }

    Remove-AzSubscriptionDiagnosticSetting -SubscriptionId $SubscriptionIdToRemoveDiagSetting -Name $diagnosticSettingName -ErrorAction Stop

    Write-Host "Finished removing diagnostic setting from subscription '${SubscriptionIdToRemoveDiagSetting}'."
}

function Get-DiagnosticSettingExists {
    [CmdletBinding()]
    param (
        $SubscriptionId
    )

    $existingDiagSettings = Get-AzSubscriptionDiagnosticSetting -SubscriptionId $SubscriptionId -ErrorAction Stop
    foreach ($existingDiagSetting in $existingDiagSettings) {
        if ($existingDiagSetting.Name.ToLower().Equals($diagnosticSettingName.ToLower())) {
            return $true;
        }
    }

    return $false;
}

# Infer EventHubAuthRuleId if required
if ($PSBoundParameters.ContainsKey('DestinationSubscriptionId')) {
    $EventHubAuthRuleId = "/subscriptions/${DestinationSubscriptionId}/resourceGroups/${ExistingResourceGroupName}/providers/Microsoft.EventHub/namespaces/splkActLogsEH${SCDMInputId}/authorizationRules/splk-activity-logs-eventhub-auth-send"
    Write-Host "Using Event Hub authorization rule id '${EventHubAuthRuleId}'"
}

try {
    # Create log setting object for all categories of subscription diagnostic settings
    $subscriptionLogSettingsObjects = @()
    Get-AzEventCategory -ErrorAction Stop | ForEach-Object {
        $subscriptionLogSettingsObjects += (New-AzDiagnosticSettingSubscriptionLogSettingsObject -Category $_.Value -Enabled $true -ErrorAction Stop)
    }
    $diagnosticSettingName = "splunk-activity-logs-" + $SCDMInputId

    # Get all subscriptions in tenant
    Write-Host "Getting subscriptions for tenant '${TenantId}'."
    Set-AzContext -Tenant $TenantId
    $subscriptions = Get-AzSubscription -TenantId $TenantId -ErrorAction Stop
    Write-Host "Found subscriptions for tenant: '${subscriptions}'."

    foreach ($subscription in $subscriptions) {
        if ($SubscriptionsThatMustHaveDiagnosticSettings -contains $subscription.Id) {
            Set-DiagnosticSetting -SubscriptionIdToEnableDiagSetting $subscription.Id
        }
        else {
            Remove-DiagnosticSetting -SubscriptionIdToRemoveDiagSetting $subscription.Id
        }
    }
}
catch {
    Write-Error -Message "There was an error updating diagnostic settings. Please resolve the problem and retry."
    Write-Error -Exception $PSItem.Exception
}