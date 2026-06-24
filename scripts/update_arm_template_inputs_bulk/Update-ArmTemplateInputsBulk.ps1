<#
.SYNOPSIS
    Bulk upgrades Splunk Data Manager Azure Monitor Logs inputs to ARM version 4.6.

.DESCRIPTION
    Queries all AAD and Activity Logs inputs across one or more subscriptions that are not
    yet on ARM version 4.6 and redeploys them with the updated ARM template and function
    package. Supports dry-run (what-if) mode, parallel batch deployments, and per-input
    error handling with optional auto-skip.

.PARAMETER SubscriptionIds
    Required. One or more Azure subscription IDs to query and upgrade inputs in.
    Accepts a comma-separated list or an array. To load from a file:
        -SubscriptionIds (Get-Content subscriptions.txt)

.PARAMETER Limit
    Maximum number of inputs to process per subscription. Defaults to 1000. Must be greater than 0.
    Results are fetched in pages of up to 1000 — values above 1000 trigger multiple API calls per subscription.

.PARAMETER BatchSize
    Number of deployments to run in parallel per batch. Defaults to -1, which uses the Limit value as the batch size
    (i.e. all discovered inputs per subscription are processed in a single batch). Must be greater than 0 or -1.

.PARAMETER DeploymentTimeoutSeconds
    Maximum seconds to wait per batch for deployments to complete. Defaults to 1800 (30 minutes). Must be greater than 0.

.PARAMETER DryRun
    Runs ARM what-if deployments instead of actual deployments. No changes are made to Azure resources.

.PARAMETER AutoSkipErrors
    When set, failed inputs are skipped and execution continues with remaining inputs.
    When not set, execution is cancelled on the first failure.

.PARAMETER ForceInputIds
    One or more scdmInputId GUIDs to reprocess regardless of their current SplunkInputARMVersion tag.
    Use this to retry inputs that failed mid-deployment and were partially upgraded (e.g. function app
    tagged 4.6 but other resources failed). These inputs are normally excluded from discovery.

.PARAMETER ForceOnly
    When set, skips normal discovery entirely and only processes inputs listed in -ForceInputIds.
    Requires -ForceInputIds to be specified. Use this to target a specific set of inputs without
    querying all eligible inputs in the subscription.

.EXAMPLE
    # Dry run on a single subscription — preview changes without deploying
    .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -DryRun

.EXAMPLE
    # Upgrade all eligible inputs across multiple subscriptions
    .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id-1","sub-id-2","sub-id-3"

.EXAMPLE
    # Load subscription IDs from a file and upgrade with auto-skip
    .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds (Get-Content subscriptions.txt) -AutoSkipErrors

.EXAMPLE
    # Upgrade first 50 inputs in a single batch (default), auto-skipping errors
    .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -Limit 50 -AutoSkipErrors

.EXAMPLE
    # Upgrade with explicit batch size of 25
    .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -BatchSize 25 -AutoSkipErrors

.NOTES
    Copyright 2024 Splunk Inc.
    Licensed under the Apache License, Version 2.0.
    See http://www.apache.org/licenses/LICENSE-2.0 for full license text.

    Requires: Az, Az.ResourceGraph PowerShell modules.
    Install:  Install-Module -Name Az -Scope CurrentUser
              Install-Module -Name Az.ResourceGraph -Scope CurrentUser

    Authentication:
    - The script does not manage authentication. Authenticate before running:
        Connect-AzAccount                                  # interactive
        Connect-AzAccount -Identity                        # managed identity (Azure VM / Cloud Shell)
        Connect-AzAccount -TenantId "your-tenant-id"      # specific tenant
    - For long runs, ensure your session token does not expire mid-run.
      On an Azure VM with system-assigned managed identity, tokens are refreshed automatically
      and reliably. Cloud Shell managed identity tokens may expire — prefer Azure VM for large runs.

    ARM deployments submitted via -AsJob will continue on Azure even if the script is interrupted.
    Monitor in-flight deployments at: Azure Portal -> Subscription -> Deployments
    Or run (per subscription): Set-AzContext -Subscription "<your-sub-id>"; Get-AzSubscriptionDeployment | Where-Object { $_.DeploymentName -like 'SplunkDMDataIngest-*' }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]]$SubscriptionIds,

    [int]$Limit = 1000,

    [int]$BatchSize = -1,

    [int]$DeploymentTimeoutSeconds = 1800,

    [switch]$DryRun,

    [switch]$AutoSkipErrors,

    [string[]]$ForceInputIds = @(),

    [switch]$ForceOnly
)

function Get-InputDeploymentParams {
    param(
        [PSCustomObject]$Record,
        [string]$ArmVersion,
        [string]$FunctionPackageURL,
        [hashtable]$TemplateUris
    )

    Write-Host "  Fetching function app settings..."
    $settings = (Get-AzWebApp -ResourceGroupName $Record.resourceGroup -Name $Record.functionName).SiteConfig.AppSettings
    $hecUrl   = ($settings | Where-Object Name -eq 'HecUrl').Value
    $hecToken = ($settings | Where-Object Name -eq 'HecToken').Value

    Write-Host "  Fetching service principal..."
    $spObjectId = (Get-AzRoleAssignment `
        -ResourceGroupName  $Record.resourceGroup `
        -RoleDefinitionName "splunk-dm-read-only-$($Record.scdmInputId)" |
        Select-Object -First 1).ObjectId

    if (-not $hecUrl -or -not $hecToken -or -not $spObjectId) {
        throw "Missing required parameters: hecUrl=<$(if ($hecUrl) { 'set' } else { 'empty' })>, hecToken=<$(if ($hecToken) { 'set' } else { 'empty' })>, spObjectId=<$(if ($spObjectId) { 'set' } else { 'empty' })>"
    }

    Write-Host "  Fetching resource group tags..."
    $rgTags = (Get-AzResourceGroup -Name $Record.resourceGroup).Tags
    $resourceTags = @{ SplunkInputARMVersion = $ArmVersion }
    if ($rgTags) {
        foreach ($key in $rgTags.Keys) {
            if ($key -ne 'SplunkInputARMVersion') {
                $resourceTags[$key] = $rgTags[$key]
            }
        }
    }

    return @{
        Name                    = "SplunkDMDataIngest-$($Record.scdmInputId)"
        Location                = $Record.location
        TemplateUri             = $TemplateUris[$Record.inputType]
        TemplateParameterObject = @{
            hecUrl                    = $hecUrl
            hecToken                  = $hecToken
            region                    = $Record.location
            functionPackageURL        = $FunctionPackageURL
            scdmInputId               = $Record.scdmInputId
            servicePrincipalObjectId  = $spObjectId
            resourceTags              = $resourceTags
        }
    }
}

function Invoke-BulkUpgrade {
    param(
        [System.Collections.Generic.List[PSCustomObject]]$Records,
        [string]$ArmVersion,
        [string]$FunctionPackageURL,
        [hashtable]$TemplateUris,
        [int]$BatchSize,
        [int]$DeploymentTimeoutSeconds,
        [System.Collections.Generic.List[System.Management.Automation.Job]]$AllJobs,
        [switch]$DryRun,
        [switch]$AutoSkipErrors
    )

    $failedInputs  = [System.Collections.Generic.List[PSCustomObject]]::new()
    $timedOutInputs = [System.Collections.Generic.List[PSCustomObject]]::new()
    $i             = 0
    $successCount  = 0
    $cancelled     = $false

    for ($batchStart = 0; $batchStart -lt $Records.Count -and -not $cancelled; $batchStart += $BatchSize) {
        $batch = $Records.GetRange($batchStart, [Math]::Min($BatchSize, $Records.Count - $batchStart))
        $jobs  = [System.Collections.Generic.List[PSCustomObject]]::new()

        foreach ($record in $batch) {
            $i++

            Write-Host "----------------------------------------"
            Write-Host "[$i/$($Records.Count)]"
            Write-Host "  Input ID:        $($record.scdmInputId)"
            $inputTypeLabel = if ($record.inputType -eq 'aad') { 'Azure AD Logs' } else { 'Azure Activity Logs' }
            Write-Host "  Type:            $inputTypeLabel"
            Write-Host "  Subscription:    $($record.subscriptionId)"
            Write-Host "  Resource Group:  $($record.resourceGroup)"
            Write-Host "  Location:        $($record.location)"
            Write-Host "  Current Version: $(if ($record.armVersion) { $record.armVersion } else { 'untagged' })"
            Write-Host "----------------------------------------"

            try {
                $deploymentParams = Get-InputDeploymentParams -Record $record -ArmVersion $ArmVersion -FunctionPackageURL $FunctionPackageURL -TemplateUris $TemplateUris

                if ($DryRun) {
                    Write-Host "  [DRY RUN] Running what-if deployment..."
                    New-AzSubscriptionDeployment @deploymentParams -WhatIf
                    Write-Host "  [DRY RUN] Input $($record.scdmInputId) — what-if complete."
                    $successCount++
                } else {
                    Write-Host "  Queued for deployment..."
                    $job = New-AzSubscriptionDeployment @deploymentParams -AsJob
                    $jobs.Add([PSCustomObject]@{ Job = $job; Record = $record })
                    $AllJobs.Add($job)
                }
            } catch {
                $errorMessage = $_.Exception.Message
                Write-Host "  ERROR: $errorMessage"
                $failedInputs.Add([PSCustomObject]@{
                    ScdmInputId    = $record.scdmInputId
                    SubscriptionId = $record.subscriptionId
                    ResourceGroup  = $record.resourceGroup
                    Error          = $errorMessage
                })

                if (-not $AutoSkipErrors) {
                    Write-Host "Execution cancelled due to pre-flight failure."
                    $cancelled = $true
                    break
                }
            }

            Write-Host ""
        }

        if (-not $DryRun -and $jobs.Count -gt 0) {
            Write-Host "Waiting for batch of $($jobs.Count) deployment(s) to complete..."
            $batchTimer = Get-Date
            $deadline   = $batchTimer.AddSeconds($DeploymentTimeoutSeconds)
            do {
                Start-Sleep -Seconds 10
                $pending   = ($jobs | Where-Object { $_.Job.State -notin 'Completed','Failed','Stopped' }).Count
                $completed = ($jobs | Where-Object { $_.Job.State -eq 'Completed' }).Count
                $failed    = ($jobs | Where-Object { $_.Job.State -in 'Failed','Stopped' }).Count
                $elapsed   = [int]((Get-Date) - $batchTimer).TotalSeconds
                Write-Host "  Status: $completed completed, $failed failed, $pending still running... (${elapsed}s elapsed)"
            } while ($pending -gt 0 -and (Get-Date) -lt $deadline)
            $batchElapsed = (Get-Date) - $batchTimer
            Write-Host "  Batch completed in $("{0:D2}m {1:D2}s" -f $batchElapsed.Minutes, $batchElapsed.Seconds)."

            foreach ($jobRecord in $jobs) {
                $job    = $jobRecord.Job
                $record = $jobRecord.Record

                if ($job.State -eq 'Completed') {
                    $deploymentResult = $null
                    $receiveError     = $null
                    try { $deploymentResult = Receive-Job -Job $job -ErrorAction Stop | Select-Object -Last 1 } catch { $receiveError = $_.Exception.Message }

                    if ($deploymentResult -and $deploymentResult.ProvisioningState -eq 'Succeeded') {
                        Write-Host "  [$($record.scdmInputId)] Upgrade complete."
                        $successCount++
                    } else {
                        $armError = if ($receiveError) { $receiveError }
                                    elseif ($deploymentResult) { "ARM deployment state: $($deploymentResult.ProvisioningState)" }
                                    else { "No deployment result returned" }
                        Write-Host "  ERROR [$($record.scdmInputId)]: $armError"
                        $failedInputs.Add([PSCustomObject]@{
                            ScdmInputId    = $record.scdmInputId
                            SubscriptionId = $record.subscriptionId
                            ResourceGroup  = $record.resourceGroup
                            Error          = $armError
                        })
                        if (-not $AutoSkipErrors) {
                            Write-Host "Execution cancelled due to deployment failure."
                            $cancelled = $true
                        }
                    }
                    $AllJobs.Remove($job) | Out-Null
                    Remove-Job $job | Out-Null
                } elseif ($job.State -in 'Failed', 'Stopped') {
                    Write-Host "  ERROR [$($record.scdmInputId)]: job $($job.State) — check Azure Portal for deployment status"
                    $failedInputs.Add([PSCustomObject]@{
                        ScdmInputId    = $record.scdmInputId
                        SubscriptionId = $record.subscriptionId
                        ResourceGroup  = $record.resourceGroup
                        Error          = "Job $($job.State) — deployment status unknown"
                    })
                    if (-not $AutoSkipErrors) {
                        Write-Host "Execution cancelled due to deployment failure."
                        $cancelled = $true
                    }
                    $AllJobs.Remove($job) | Out-Null
                    Remove-Job $job | Out-Null
                } else {
                    # Non-terminal state (Running, NotStarted, Suspended, Disconnected, etc.)
                    # Leave in $AllJobs so the finally block reports it as pending on Azure.
                    Write-Host "  WARNING [$($record.scdmInputId)]: deployment $($job.State) after timeout — will continue on Azure independently."
                    $timedOutInputs.Add([PSCustomObject]@{
                        ScdmInputId    = $record.scdmInputId
                        SubscriptionId = $record.subscriptionId
                        ResourceGroup  = $record.resourceGroup
                    })
                }
            }

            Write-Host ""
        }
    }

    return [PSCustomObject]@{
        ProcessedCount  = $successCount
        FailedInputs    = $failedInputs
        TimedOutInputs  = $timedOutInputs
    }
}

$allJobs         = [System.Collections.Generic.List[System.Management.Automation.Job]]::new()
$scriptStart     = Get-Date
$originalContext = Get-AzContext -ErrorAction SilentlyContinue

try {

if ($Limit -le 0) { throw "Limit must be greater than 0" }
if ($BatchSize -eq 0 -or $BatchSize -lt -1) { throw "BatchSize must be greater than 0 or -1 (use Limit as batch size)" }
if ($DeploymentTimeoutSeconds -le 0) { throw "DeploymentTimeoutSeconds must be greater than 0" }

# -1 means use Limit as batch size — process all inputs per subscription in one batch
if ($BatchSize -eq -1) { $BatchSize = $Limit }

# Remove blank entries that can appear when loading subscription IDs from a file
$SubscriptionIds = @($SubscriptionIds | Where-Object { $_ -ne '' })
if ($SubscriptionIds.Count -eq 0) { throw "No valid subscription IDs provided — check your input for blank or empty entries" }
if ($ForceOnly -and $ForceInputIds.Count -eq 0) { throw "-ForceOnly requires -ForceInputIds to be specified" }

if ($DryRun) {
    Write-Host "INFO: Dry-run mode — ARM what-if deployments run synchronously (no -AsJob)."
    Write-Host "      Each input is validated one at a time. For large input sets this can take a long time."
    Write-Host ""
}

if (-not (Get-Module -ListAvailable -Name Az.ResourceGraph)) {
    throw "Az.ResourceGraph module is not installed. Run: Install-Module -Name Az.ResourceGraph -Scope CurrentUser"
}

$armVersion     = '4.6'
$packageVersion = '4.6.0'

$query = @"
ResourceContainers
| where type == 'microsoft.resources/subscriptions/resourcegroups'
| where tags['SplunkDMInputId'] != ''
| join kind=inner (
    Resources
    | where type == 'microsoft.web/sites'
    | where name startswith 'splkAadLogsFn' or name startswith 'splkActLogsFn'
    | where isempty(tags['SplunkInputARMVersion']) or tags['SplunkInputARMVersion'] != '$armVersion'
    | project resourceGroup, functionName = name, armVersion = tags['SplunkInputARMVersion'],
              inputType = iff(name startswith 'splkAadLogsFn', 'aad', 'activity')
) on resourceGroup
| project subscriptionId, resourceGroup, scdmInputId = tags['SplunkDMInputId'],
          functionName, inputType, armVersion, location
"@

$splunkRGs        = [System.Collections.Generic.List[PSCustomObject]]::new()
$skippedSubscriptions  = [System.Collections.Generic.List[string]]::new()

if ($ForceOnly) {
    Write-Host "Skipping normal discovery — processing only -ForceInputIds ($($ForceInputIds.Count) input(s))..."
} else {
    Write-Host "Querying inputs eligible for upgrade ($($SubscriptionIds.Count) subscription(s), limit: $Limit per subscription)..."

    foreach ($subId in $SubscriptionIds) {
        try {
            $pageSize   = [Math]::Min($Limit, 1000)
            $response   = Search-AzGraph -Query $query -First $pageSize -Subscription $subId -ErrorAction Stop
            $subResults = [System.Collections.Generic.List[PSCustomObject]]::new()
            if ($response) { $subResults.AddRange($response) }

            while ($response.SkipToken -and $subResults.Count -lt $Limit) {
                $remaining = $Limit - $subResults.Count
                $response  = Search-AzGraph -Query $query -First ([Math]::Min($remaining, 1000)) -SkipToken $response.SkipToken -Subscription $subId -ErrorAction Stop
                if ($response) { $subResults.AddRange($response) }
            }

            if ($subResults.Count -gt 0) {
                Write-Host "  $subId — found $($subResults.Count) input(s)$(if ($subResults.Count -ge $Limit) { ' (limit reached, re-run to process more)' })"
                $splunkRGs.AddRange($subResults)
            } else {
                Write-Host "  $subId — no eligible inputs found."
            }
        } catch {
            Write-Host "  WARNING [$subId]: discovery failed — $($_.Exception.Message). Skipping."
            $skippedSubscriptions.Add($subId)
        }
    }
} # end -not ForceOnly

# If -ForceInputIds are specified, query them without the version filter and merge into results.
# This allows reprocessing inputs that were partially upgraded (e.g. function app tagged 4.6
# but other resources failed) and would otherwise be excluded from normal discovery.
if ($ForceInputIds.Count -gt 0) {
    $forcedIds = @($ForceInputIds | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
    Write-Host "Forcing reprocessing of $($forcedIds.Count) input(s)..."

    $forceQuery = @"
ResourceContainers
| where type == 'microsoft.resources/subscriptions/resourcegroups'
| where tags['SplunkDMInputId'] != ''
| join kind=inner (
    Resources
    | where type == 'microsoft.web/sites'
    | where name startswith 'splkAadLogsFn' or name startswith 'splkActLogsFn'
    | project resourceGroup, functionName = name, armVersion = tags['SplunkInputARMVersion'],
              inputType = iff(name startswith 'splkAadLogsFn', 'aad', 'activity')
) on resourceGroup
| project subscriptionId, resourceGroup, scdmInputId = tags['SplunkDMInputId'],
          functionName, inputType, armVersion, location
"@

    foreach ($subId in $SubscriptionIds) {
        try {
            $forceResults  = [System.Collections.Generic.List[PSCustomObject]]::new()
            $forceResponse = Search-AzGraph -Query $forceQuery -First 1000 -Subscription $subId -ErrorAction Stop
            if ($forceResponse) { $forceResults.AddRange($forceResponse) }

            while ($forceResponse.SkipToken) {
                $forceResponse = Search-AzGraph -Query $forceQuery -First 1000 -SkipToken $forceResponse.SkipToken -Subscription $subId -ErrorAction Stop
                if ($forceResponse) { $forceResults.AddRange($forceResponse) }
            }

            $forcedMatches = $forceResults | Where-Object { $forcedIds -contains $_.scdmInputId }
            foreach ($forced in $forcedMatches) {
                $splunkRGs.RemoveAll([Predicate[PSCustomObject]]{ param($r) $r.scdmInputId -eq $forced.scdmInputId }) | Out-Null
                $splunkRGs.Add($forced)
                Write-Host "  Force-added: $($forced.scdmInputId) (current tag: $(if ($forced.armVersion) { $forced.armVersion } else { 'untagged' }))"
            }
        } catch {
            Write-Host "  WARNING: Failed to query forced inputs in $subId — $($_.Exception.Message)"
        }
    }
}

if ($splunkRGs.Count -eq 0) {
    Write-Host "No inputs found eligible for upgrade."
    return
}

$aadCount      = ($splunkRGs | Where-Object { $_.inputType -eq 'aad' }).Count
$activityCount = ($splunkRGs | Where-Object { $_.inputType -eq 'activity' }).Count
$coveredSubs   = @($splunkRGs | Select-Object -ExpandProperty subscriptionId -Unique)

$subsDisplay = if ($coveredSubs.Count -le 10) {
    $coveredSubs -join ', '
} else {
    "$($coveredSubs[0..9] -join ', ') ... and $($coveredSubs.Count - 10) more"
}
Write-Host "Found $($splunkRGs.Count) input(s) to upgrade: $aadCount Azure AD Logs, $activityCount Azure Activity Logs"
Write-Host "Across $($coveredSubs.Count) subscription(s): $subsDisplay"
Write-Host ""

$templateUris = @{
    aad      = "https://raw.githubusercontent.com/splunk/splunk-azure-monitor-logs-function/release/$armVersion/deploy/aad/splunk-aad-logs-deploy-resources.json"
    activity = "https://raw.githubusercontent.com/splunk/splunk-azure-monitor-logs-function/release/$armVersion/deploy/activity/splunk-activity-logs-deploy-resources.json"
}
$functionPackageURL = "https://download.splunk.com/products/splunk-azure-monitor-logs-azure-function/releases/$packageVersion/linux/azure-monitor-logs-azure-function-$packageVersion.zip"

# Run upgrade per subscription so each batch is fully scoped to one subscription.
# This eliminates cross-subscription batch boundaries and makes ARM deployment
# verification reliable (Get-AzSubscriptionDeployment always targets the correct subscription).
$totalProcessed  = 0
$totalFailed     = [System.Collections.Generic.List[PSCustomObject]]::new()
$totalTimedOut   = [System.Collections.Generic.List[PSCustomObject]]::new()
$subCancelled    = $false

foreach ($subId in $coveredSubs) {
    if ($subCancelled) { break }

    $subInputs = [System.Collections.Generic.List[PSCustomObject]]($splunkRGs | Where-Object { $_.subscriptionId -eq $subId })

    Write-Host "----------------------------------------"
    Write-Host "Processing subscription: $subId ($($subInputs.Count) input(s))"
    Write-Host "----------------------------------------"

    try {
        Set-AzContext -Subscription $subId | Out-Null

        $result = Invoke-BulkUpgrade `
            -Records                   $subInputs `
            -ArmVersion                $armVersion `
            -FunctionPackageURL        $functionPackageURL `
            -TemplateUris              $templateUris `
            -BatchSize                 $BatchSize `
            -DeploymentTimeoutSeconds  $DeploymentTimeoutSeconds `
            -AllJobs                   $allJobs `
            -DryRun:$DryRun `
            -AutoSkipErrors:$AutoSkipErrors

        $totalProcessed += $result.ProcessedCount
        $totalFailed.AddRange($result.FailedInputs)
        $totalTimedOut.AddRange($result.TimedOutInputs)

        if ($result.FailedInputs.Count -gt 0 -and -not $AutoSkipErrors) {
            $subCancelled = $true
        }
    } catch {
        Write-Host "  ERROR: Subscription $subId skipped — $($_.Exception.Message)"
        $skippedSubscriptions.Add($subId)
        if (-not $AutoSkipErrors) { $subCancelled = $true }
    }
}

$result = [PSCustomObject]@{
    ProcessedCount = $totalProcessed
    FailedInputs   = $totalFailed
    TimedOutInputs = $totalTimedOut
}

$elapsed = (Get-Date) - $scriptStart
$elapsedStr = "{0:D2}h {1:D2}m {2:D2}s" -f $elapsed.Hours, $elapsed.Minutes, $elapsed.Seconds
$processedLabel = if ($DryRun) { 'validated (what-if)' } else { 'confirmed' }
Write-Host "$(if ($DryRun) { '[DRY RUN] ' })Done in $elapsedStr. $($result.ProcessedCount) $processedLabel, $($result.FailedInputs.Count) failed, $($result.TimedOutInputs.Count) timed out (check Azure Portal for final status)."
if ($result.FailedInputs.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed inputs:"
    foreach ($failed in $result.FailedInputs) {
        Write-Host "  $($failed.ScdmInputId) | sub: $($failed.SubscriptionId) | rg: $($failed.ResourceGroup) | error: $($failed.Error)"
    }
}
if ($result.TimedOutInputs.Count -gt 0) {
    Write-Host ""
    Write-Host "Timed out inputs (still running on Azure — verify in Portal):"
    foreach ($timedOut in $result.TimedOutInputs) {
        Write-Host "  $($timedOut.ScdmInputId) | sub: $($timedOut.SubscriptionId) | rg: $($timedOut.ResourceGroup)"
    }
}
if ($skippedSubscriptions.Count -gt 0) {
    Write-Host ""
    Write-Host "WARNING: $($skippedSubscriptions.Count) subscription(s) were skipped — inputs in these subscriptions were NOT processed:"
    $skippedSubscriptions | ForEach-Object { Write-Host "  $_" }
}

} catch {
    Write-Host "CRITICAL: Script failed — $($_.Exception.Message)"
    throw
} finally {
    $pendingJobs = $allJobs | Where-Object { $_.State -notin 'Completed', 'Failed', 'Stopped' }
    if ($pendingJobs.Count -gt 0) {
        Write-Host "Note: $($pendingJobs.Count) deployment(s) are still running on Azure and will complete independently."
        Write-Host "      Monitor progress at: Azure Portal -> Subscription -> Deployments"
        Write-Host "      Or run (per subscription): Set-AzContext -Subscription `"<your-sub-id>`"; Get-AzSubscriptionDeployment | Where-Object { `$_.DeploymentName -like 'SplunkDMDataIngest-*' }"
        $pendingJobs | Remove-Job -Force -ErrorAction SilentlyContinue
    }

    if ($originalContext) {
        Set-AzContext -Context $originalContext -ErrorAction SilentlyContinue | Out-Null
    }
}