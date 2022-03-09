Param(
    # Template to be tested
    [Parameter(Mandatory = $false)]
    [string]
    $TemplateFile = '../splunk-activity-logs-deploy-resources.json',
    # Location
    [Parameter(Mandatory = $false)]
    [string]
    $Location = "East US",
    # FunctionPackageURL
    [Parameter(Mandatory = $false)]
    [string]
    $FunctionPackageURL = "http://localhost/",
    # Service Principal Object ID
    [Parameter(Mandatory = $false)]
    [string]
    $ServicePrincipalObjectId = 'b03d5072-69eb-4165-b453-c1b1a33de468',
    # SCDM ID
    [Parameter(Mandatory = $true)]
    [string]
    $SCDMInputId
)


Describe "Azure ARM Template Unit Tests" {
    BeforeAll {
        $resourcePrefix = 'SplunkDMDataIngest-'
        $consumerGroupName = "splk-activity-logs-consumer-group"
        $eventHubAuthRuleListen = "splk-activity-logs-eventhub-auth-listen"
        $eventHubAuthRuleSend = "splk-activity-logs-eventhub-auth-send"
        $eventHubName =  "splk-activity-logs-eventhub"
        $eventHubNamespaceName =  "splkActLogsEH" + $SCDMInputId
        $functionName = "splkActLogsFn" + $SCDMInputId
        $hostingPlanName =  "splk-activity-logs-hosting-plan"

        $deploymentResult = Get-AzDeploymentWhatIfResult `
            -Name "UnitTestDeployment" `
            -Location $Location `
            -TemplateFile $TemplateFile `
            -TemplateParameterObject @{hecUrl = "http://localhost/"; hecToken = "i-am-a-token"; region = $Location; scdmInputId = $SCDMInputId; servicePrincipalObjectId = $ServicePrincipalObjectId; functionPackageURL = $FunctionPackageURL; resourceTags = @{tagKey = "tagValue"}}
    }

    Context "Deployment Successful" {
        It "Successful Deployment" {
            $deploymentResult.Status | Should -Be 'Succeeded'
        }
    }

    Context "Resources Created" {
        BeforeAll {
            $changes = $deploymentResult.Changes
            $resourceMap = @{}

            foreach ($change in $changes) {
                $type = $change.After["type"].Value

                if ($resourceMap.ContainsKey($type)) {
                    $resourceChangeList = $resourceMap[$type]
                    $resourceChangeList.Add($change)
                } else {
                    $list = New-Object Collections.Generic.List[Microsoft.Azure.Commands.ResourceManager.Cmdlets.SdkModels.Deployments.PSWhatIfChange]
                    $list.Add($change)
                    $resourceMap.Add($type, $list)
                }
            }

            Write-Output $resourceMap
        }

        It "Resource Group Created" {
            $resourceGroups = $resourceMap['Microsoft.Resources/resourceGroups']

            $resourceGroups.Count | Should -Be 1
            $resourceGroups[0].ChangeType | Should -Be "Create"

            $name = $resourcePrefix + $SCDMInputId
            $resourceGroups[0].After["name"].Value | Should -Be $name
            $resourceGroups[0].After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
            $resourceGroups[0].After["tags"]["SplunkDMDeletionOrder"].Value | Should -Be "10"
            $resourceGroups[0].After["tags"]["tagKey"].Value | Should -Be "tagValue"
        }

        It "Role Definitions Created" {
            $roleDefinitions = $resourceMap['Microsoft.Authorization/roleDefinitions']

            $roleDefinitions.Count | Should -Be 1
            $roleDefinitions[0].ChangeType | Should -Be "Create"
            $roleDefinitions[0].After["name"].Value | Should -Be $SCDMInputId

            # Assert Role permissions
            $properties = $roleDefinitions[0].After["properties"]

            $roleName = "splunk-dm-read-only-" + $SCDMInputId
            $properties["roleName"].Value | Should -Be $roleName

            $properties["type"].Value | Should -Be "CustomRole"

            $properties["assignableScopes"].Count | Should -Be 1
            $properties["assignableScopes"][0].Value | Should -Be $resourceMap['Microsoft.Resources/resourceGroups'][0].After["id"].Value

            $permissions = $properties["permissions"]
            $permissions.Count | Should -Be 1
            $permissions[0].ContainsKey("actions") | Should -Be $true
            $actions = New-Object Collections.Generic.List[string]
            foreach($action in $permissions[0]["actions"]) {
                $actions.Add($action.Value)
            }
            $actions.ToArray() | Should -Be "Microsoft.Authorization/roleDefinitions/read", `
                "Microsoft.Authorization/roleAssignments/read", `
                "Microsoft.EventHub/namespaces/read", `
                "Microsoft.EventHub/namespaces/authorizationRules/read", `
                "Microsoft.EventHub/namespaces/eventhubs/read", `
                "Microsoft.EventHub/namespaces/eventHubs/consumergroups/read", `
                "Microsoft.Resources/deployments/read", `
                "Microsoft.Resources/subscriptions/resourcegroups/read", `
                "Microsoft.Storage/storageAccounts/read", `
                "Microsoft.Web/sites/read", `
                "Microsoft.Web/serverfarms/read", `
                "Microsoft.Web/sites/sourcecontrols/read"
        }

        It "Role Assignments Created" {
            $roleAssignments = $resourceMap['Microsoft.Authorization/roleAssignments']

            $roleAssignments.Count | Should -Be 1
            $roleAssignments[0].ChangeType | Should -Be "Create"
            $roleAssignments[0].After["name"].Value | Should -Be $SCDMInputId

            $properties = $roleAssignments[0].After["properties"]
            $properties["principalId"].Value | Should -Be $ServicePrincipalObjectId
            $properties["roleDefinitionId"].Value | Should -Be $resourceMap['Microsoft.Authorization/roleDefinitions'][0].After["id"].Value
        }

        It "Eventhub Namespace Created" {
            $eventhubNamespaces = $resourceMap['Microsoft.EventHub/namespaces']

            $eventhubNamespaces.Count | Should -Be 1
            $eventhubNamespaces[0].ChangeType | Should -Be "Create"
            $eventhubNamespaces[0].After["name"].Value | Should -Be $eventHubNamespaceName
            $eventhubNamespaces[0].After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
            $eventhubNamespaces[0].After["tags"]["SplunkDMDeletionOrder"].Value | Should -Be "5"
            $eventhubNamespaces[0].After["tags"]["tagKey"].Value | Should -Be "tagValue"

            $properties = $eventhubNamespaces[0].After["properties"]
            $properties["isAutoInflateEnabled"].Value | Should -BeTrue
            $properties["maximumThroughputUnits"].Value | Should -Be 40

            $sku = $eventhubNamespaces[0].After["sku"]
            $sku["name"].Value | Should -Be "Standard"
        }

        It "Eventhub Created" {
            $eventHubs = $resourceMap['Microsoft.EventHub/namespaces/eventhubs']

            $eventHubs.Count | Should -Be 1
            $eventHubs[0].ChangeType | Should -Be "Create"
            $eventHubs[0].After["name"].Value | Should -Be $eventHubName

            $properties = $eventHubs[0].After["properties"]
            $properties["partitionCount"].Value | Should -Be 32
        }

        It "Consumer Group Created" {
            $consumerGroups = $resourceMap['Microsoft.EventHub/namespaces/eventhubs/consumergroups']

            $consumerGroups | Should -HaveCount 1
            $consumerGroups[0].ChangeType | Should -Be "Create"
            $consumerGroups[0].After["name"].Value | Should -Be $consumerGroupName
        }

        It "Authorization Rules Created" {
            $authRules = $resourceMap['Microsoft.EventHub/namespaces/AuthorizationRules']

            $authRules | Should -HaveCount 2

            foreach($authRule in $authRules) {
                $authRule.ChangeType | Should -Be "Create"
                $authRule.After["name"].Value | Should -BeIn @($eventHubAuthRuleListen, $eventHubAuthRuleSend)

                if ($authRule.After["name"].Value -eq $eventHubAuthRuleListen) {
                    $rights = New-Object Collections.Generic.List[string]
                    foreach($right in $authRule.After["properties"]["rights"]) {
                        $rights.Add($right.Value)
                    }
                    $rights.ToArray() | Should -Be 'Listen'
                } else {
                    $rights = New-Object Collections.Generic.List[string]
                    foreach($right in $authRule.After["properties"]["rights"]) {
                        $rights.Add($right.Value)
                    }
                    $rights.ToArray() | Should -Be 'Send'
                }
            }
        }

        It "Storage Account Created" {
            $storageAccounts = $resourceMap['Microsoft.Storage/storageAccounts']

            $storageAccounts | Should -HaveCount 3
            foreach ($storageAccount in $storageAccounts) {
                $storageAccount.ChangeType | Should -Be "Create"
                $storageAccount.After["sku"]["name"].Value | Should -Be "Standard_LRS"
                $storageAccount.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $storageAccount.After["tags"]["tagKey"].Value | Should -Be "tagValue"
            }
        }

        It "App Service Plan Created" {
            $appServicePlans = $resourceMap['Microsoft.Web/serverfarms']

            $appServicePlans | Should -HaveCount 1
            $appServicePlans[0].ChangeType | Should -Be "Create"
            $appServicePlans[0].After["name"].Value | Should -Be $hostingPlanName
            $appServicePlans[0].After["kind"].Value | Should -Be "functionapp"
            $appServicePlans[0].After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
            $appServicePlans[0].After["tags"]["SplunkDMDeletionOrder"].Value | Should -Be "2"
            $appServicePlans[0].After["tags"]["tagKey"].Value | Should -Be "tagValue"
            $appServicePlans[0].After["sku"]["name"].Value | Should -Be "Y1"
            $appServicePlans[0].After["properties"]["reserved"].Value | Should -Be $true
        }

        It "Function Created" {
            $functions = $resourceMap['Microsoft.Web/sites']

            $functions | Should -HaveCount 1
            $functions[0].ChangeType | Should -Be "Create"
            $functions[0].After["name"].Value | Should -Be $functionName
            $functions[0].After["kind"].Value | Should -Be "functionapp,linux"
            $functions[0].After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
            $functions[0].After["tags"]["SplunkDMDeletionOrder"].Value | Should -Be "1"
            $functions[0].After["tags"]["tagKey"].Value | Should -Be "tagValue"
        }
    }
}