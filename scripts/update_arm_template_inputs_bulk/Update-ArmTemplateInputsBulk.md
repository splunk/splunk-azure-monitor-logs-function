# Update-ArmTemplateInputsBulk.ps1

Bulk upgrades Splunk Data Manager Azure Monitor Logs inputs to ARM version 4.6.

## Overview

This script upgrades **Azure AD Logs and Activity Logs inputs** that were deployed into their **own dedicated resource groups** (the standard DM provisioning model — one resource group per input, named `SplunkDMDataIngest-{inputId}`). It does not support inputs deployed into pre-existing shared resource groups.

The core operation is: **read the existing input configuration, then re-apply the 4.6 ARM template with the same parameters**. No values are changed — HEC credentials, service principal, and resource group tags are all read from the live resources and passed through unchanged to the new deployment.

## Prerequisites

- PowerShell 7+
- `Az` PowerShell module
- `Az.ResourceGraph` module
- An authenticated Azure session with access to the target subscription(s)

```powershell
Install-Module -Name Az -Scope CurrentUser
Install-Module -Name Az.ResourceGraph -Scope CurrentUser
```

> **Authentication is the caller's responsibility.** The script does not manage tokens or sessions. For large runs that may exceed token TTL, use an Azure VM with a system-assigned managed identity — tokens are refreshed automatically on VMs and do not expire like Cloud Shell sessions.

## Usage

```powershell
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds <string[]> [-Limit <int>] [-BatchSize <int>] [-DeploymentTimeoutSeconds <int>] [-DryRun] [-AutoSkipErrors] [-ForceInputIds <string[]>] [-ForceOnly]
```

### Parameters

| Parameter | Required | Default | Description |
|---|---|---|---|
| `-SubscriptionIds` | Yes | — | One or more subscription IDs. Accepts array or `(Get-Content file.txt)` |
| `-Limit` | No | 1000 | Max inputs to process per subscription |
| `-BatchSize` | No | -1 | Deployments per batch. `-1` = use `Limit` (all inputs in one batch). Larger values speed up execution but increase ARM write pressure |
| `-DeploymentTimeoutSeconds` | No | 1800 | Seconds to wait per batch before treating remaining jobs as timed out |
| `-DryRun` | No | false | Run ARM what-if instead of actual deployment — no changes made |
| `-AutoSkipErrors` | No | false | Skip failed inputs and continue; without this flag the run cancels on first failure |
| `-ForceInputIds` | No | — | One or more scdmInputId GUIDs to reprocess regardless of their current version tag. See [Retrying partially upgraded inputs](#retrying-partially-upgraded-inputs) |
| `-ForceOnly` | No | false | Skip normal discovery entirely and process only `-ForceInputIds`. Requires `-ForceInputIds` to be specified |

### Examples

```powershell
# Dry run — preview changes without deploying
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -DryRun

# Upgrade all eligible inputs across multiple subscriptions
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id-1","sub-id-2" -AutoSkipErrors

# Load subscription IDs from a file
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds (Get-Content subscriptions.txt) -AutoSkipErrors

# Explicit batch size of 25 for tighter throttle control
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -BatchSize 25 -AutoSkipErrors

# Retry specific partially upgraded inputs only
$ids = @("a65d3c47-f790-4905-a8f7-7aa0af079660","b2ac24d9-becb-41fd-b3a7-56bfa0c95eef")
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id-1","sub-id-2" -ForceInputIds $ids -ForceOnly -AutoSkipErrors

# Dry run on specific forced inputs
$ids = @("a65d3c47-f790-4905-a8f7-7aa0af079660","b2ac24d9-becb-41fd-b3a7-56bfa0c95eef")
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "your-sub-id" -ForceInputIds $ids -ForceOnly -DryRun
```

> **Note on passing arrays in Cloud Shell:** Backtick (`` ` ``) line continuation in PowerShell is fragile — a trailing space after the backtick silently breaks the continuation and can cause array parameters like `-ForceInputIds` to be misbound to the wrong parameter (e.g. `-Limit`). Always assign multi-value arrays to a variable first, or use splatting:
>
> ```powershell
> # Safe — variable assignment
> $ids = @("guid-1","guid-2","guid-3")
> .\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id" -ForceInputIds $ids -ForceOnly -DryRun
>
> # Safe — splatting
> $params = @{ SubscriptionIds = @("sub-id-1","sub-id-2"); ForceInputIds = @("guid-1","guid-2"); ForceOnly = $true; DryRun = $true }
> .\Update-ArmTemplateInputsBulk.ps1 @params
> ```

## How it works

### 1. Discovery (`Search-AzGraph`)

Queries Azure Resource Graph for all resource groups tagged with `SplunkDMInputId` that contain a function app (`splkAadLogsFn*` or `splkActLogsFn*`) not yet tagged `SplunkInputARMVersion=4.6`. Each subscription is queried independently so the `-Limit` cap applies fairly per subscription rather than truncating later subscriptions.

When `-ForceOnly` is set, this step is skipped entirely — only the inputs specified in `-ForceInputIds` are queried (without the version filter).

### 2. Pre-flight parameter collection (`Get-InputDeploymentParams`)

For each eligible input, three values are read from the **existing live resources** before redeployment:

| Value | Source |
|---|---|
| `HecUrl`, `HecToken` | Function App app settings via `Get-AzWebApp` |
| `servicePrincipalObjectId` | Role assignment `splunk-dm-read-only-{inputId}` via `Get-AzRoleAssignment` |
| Resource group tags | `Get-AzResourceGroup` — merged with `SplunkInputARMVersion=4.6` |

If any of these are missing the input is skipped with a pre-flight error.

### 3. Subscription sequencing and ARM redeployment (`New-AzSubscriptionDeployment -AsJob`)

**Subscriptions are processed sequentially** — one subscription fully completes before the next begins. This is intentional:

- `New-AzSubscriptionDeployment` uses the active session context (`Set-AzContext`) to determine the target subscription. It does not accept an explicit `-Subscription` parameter.
- Processing subscriptions in parallel would require concurrent `Set-AzContext` calls in the same session, which would cause context drift and misdirect deployments to the wrong subscription.
- Within each subscription, deployments are submitted as background jobs (`-AsJob`) so all inputs in the subscription deploy in parallel on Azure.

`Set-AzContext` is called once per subscription before any pre-flight or deployment calls are made. The subscription context is guaranteed to be correct for all operations within that subscription's processing window.

Template URIs:
- AAD Logs: `release/4.6/deploy/aad/splunk-aad-logs-deploy-resources.json`
- Activity Logs: `release/4.6/deploy/activity/splunk-activity-logs-deploy-resources.json`

### 4. Batch wait and result collection

After all jobs in a batch are submitted, the script polls every 10 seconds until all jobs reach a terminal state (`Completed`, `Failed`, `Stopped`) or `DeploymentTimeoutSeconds` is reached. Results are classified as:
- **Confirmed** — job `Completed` and `ProvisioningState = Succeeded`
- **Failed** — job `Completed` but ARM deployment failed/canceled, or job `Failed`/`Stopped`
- **Timed out** — job still running after timeout; deployment continues on Azure independently

## Dry-run mode

When `-DryRun` is set, the script runs ARM **what-if deployments** (`-WhatIf`) instead of actual deployments. No Azure resources are created, modified, or deleted.

**How it works:**
- Discovery runs normally — the same Resource Graph query identifies eligible inputs
- Pre-flight runs normally — `HecUrl`, `HecToken`, service principal, and RG tags are fetched from live resources
- Instead of `-AsJob`, each deployment is submitted synchronously via `New-AzSubscriptionDeployment -WhatIf`
- Azure evaluates what changes would be made and returns a what-if result printed to the console
- `$successCount` tracks inputs that passed what-if validation without errors

**Parallelization constraint:** Dry-run deployments are **sequential, not parallel**. Because `-WhatIf` runs synchronously (no `-AsJob`), each input is validated one at a time. For large input sets this means dry-run can take significantly longer than the actual upgrade run.

## Batching and Azure rate limits

ARM write operations are subject to a **1,200 writes/hour per subscription** limit. Each `New-AzSubscriptionDeployment` call counts as one write.

`BatchSize` controls how many deployments are submitted before waiting for results:
- **Larger `BatchSize`** → more parallel deployments → faster overall execution → higher write rate
- **Smaller `BatchSize`** → lower write pressure → safer for subscriptions with many concurrent operations

The default `-1` (= use `Limit` as batch size) submits all discovered inputs at once. For subscriptions with 500+ inputs, consider an explicit `BatchSize` of 50–100 to stay within throttle limits.

**How batching helps with rate limits (indirectly):** The script does not add explicit delays between submissions. Instead, the natural wait between batches — polling every 10 seconds until the current batch's ARM deployments complete (~1–2 minutes) — acts as organic pacing. Smaller batches mean more frequent waits, which spreads submissions over time and reduces the chance of hitting the 1,200 writes/hour ceiling. This is a side effect of the batch-wait mechanism, not a dedicated throttle guard.

## ARM deployment behavior

Deployments use **Incremental mode** — existing resources are updated in place, nothing is deleted. EventHub consumer group checkpoints are preserved; there is no data loss.

Re-running the script is safe — inputs already upgraded to 4.6 are excluded from discovery by the Resource Graph query (`SplunkInputARMVersion != '4.6'`).

### Partial upgrade failure risk

ARM deploys resources sequentially based on `dependsOn` ordering. If the deployment fails after the Function App is successfully updated (and tagged `4.6`) but before a later resource (e.g. EventHub diagnostic settings, role assignment) is updated, the input will be **excluded from subsequent discovery runs** because the function app tag already shows `4.6`.

The script correctly reports these as `Failed` in the end-of-run summary. To reprocess them use `-ForceInputIds`.

## Retrying partially upgraded inputs

If a deployment failed mid-way and the input is now excluded from normal discovery, use `-ForceInputIds` to force reprocessing regardless of the current version tag:

```powershell
# Retry specific inputs that failed mid-deployment
$ids = @("a65d3c47-f790-4905-a8f7-7aa0af079660","b2ac24d9-becb-41fd-b3a7-56bfa0c95eef")
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id-1","sub-id-2" -ForceInputIds $ids -AutoSkipErrors

# Retry only those inputs, skip normal discovery entirely
$ids = @("a65d3c47-f790-4905-a8f7-7aa0af079660","b2ac24d9-becb-41fd-b3a7-56bfa0c95eef")
.\Update-ArmTemplateInputsBulk.ps1 -SubscriptionIds "sub-id-1","sub-id-2" -ForceInputIds $ids -ForceOnly -AutoSkipErrors
```

- Forced inputs are discovered without the version filter and merged with normally discovered inputs
- When `-ForceOnly` is set, normal discovery is skipped entirely — only forced inputs are processed
- If a forced input is also returned by normal discovery, the forced version takes precedence
- Forced inputs must belong to one of the subscriptions in `-SubscriptionIds` — inputs in other subscriptions will not be found
- The IDs are the `scdmInputId` values shown in the failed inputs summary at the end of the previous run

## Interruption behavior

If the script is interrupted, any ARM deployments already submitted via `-AsJob` will **continue running on Azure** and complete independently.
Monitor in-flight deployments per subscription should be visible withing the Azure-provided tools.