<#PSScriptInfo

.VERSION 1.0

.GUID d6f1fc4a-72d6-4094-86a3-4504b657d12b

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
    For a given SCDM input, this script deletes diagnostic settings on
    resource ids passed in. 

.PARAMETER ResourcesToDisableDiagnosticSettings
    A list of resource IDs that should have diagnostic settings removed on
    by the end of the script.

.PARAMETER SCDMInputId
    The ID of the SCDM input.

.EXAMPLE
    The example below deletes a diagnostic setting on an Azure function resource.
    ./Delete-ResourceDiagnosticSettings.ps1 `
        -ResourcesToDisableDiagnosticSettings @('/subscriptions/c83c2282-2e21-4f64-86ae-fdfa66b673eb/resourceGroups/SplunkDMDataIngest-3da4204b-9293-42eb-997b-819bb5a4dfef/providers/Microsoft.Web/sites/splkResLogsFn3da4204b-9293-42eb-997b-819bb5a4dfef') `
        -SCDMInputId 3da4204b-9293-42eb-997b-819bb5a4dfef
#>

param (
    [Parameter(Mandatory = $true)]
    [string[]] $ResourcesToDisableDiagnosticSettings,
    [Parameter(Mandatory = $true)]
    [string] $SCDMInputId
)

function Get-DiagnosticSettingExists {
    [CmdletBinding()]
    param (
        $ResourceId
    )

    $existingDiagSettings = Get-AzDiagnosticSetting -ResourceId $ResourceId -ErrorAction Stop -WarningAction Ignore
    foreach ($existingDiagSetting in $existingDiagSettings) {
        if ($existingDiagSetting.Name.ToLower().Equals($diagnosticSettingName.ToLower())) {
            return $true;
        }
    }
    return $false;
}

function Remove-DiagnosticSetting {
    [CmdletBinding()]
    param (
        $ResourceId
    )

    $diagnosticSettingName = "splunk-resource-logs-" + $SCDMInputId
    Write-Host "Removing diagnostic setting '${diagnosticSettingName}' from resource '${ResourceId}'."

    if (Get-DiagnosticSettingExists -ResourceId $ResourceId) {
        Remove-AzDiagnosticSetting -ResourceId $ResourceId -Name $diagnosticSettingName -WarningAction Ignore
        Write-Host "Finished removing diagnostic setting '${diagnosticSettingName}' from resource '${ResourceId}'."
    } 
    else {
        Write-Host "Setting does not exist. Skipping removal of the diagnostic setting '${diagnosticSettingName}' from resource '${ResourceId}'."
    }
}

try {
    foreach ($resourceId in $ResourcesToDisableDiagnosticSettings) {
        Remove-DiagnosticSetting -ResourceId $resourceId
    }
}
catch {
    Write-Error -Message "There was an error removing diagnostic settings. Please resolve the problem and retry."
    Write-Error -Exception $PSItem.Exception
}