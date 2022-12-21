Param(
    # Template to be tested
    [Parameter(Mandatory = $false)]
    [string]
    $TemplateFile = '../splunk-resource-logs-deploy-resources.json',
    # FunctionPackageURL
    [Parameter(Mandatory = $false)]
    [string]
    $FunctionPackageURL = "http://localhost/",
    # Service Principal Object ID
    [Parameter(Mandatory = $false)]
    [string]
    $ServicePrincipalObjectId = 'b03d5072-69eb-4165-b453-c1b1a33de468',
    # Regions
    [Parameter(Mandatory = $false)]
    [array]
    $Regions = @('eastus', 'westus'),
    # Location
    [Parameter(Mandatory = $false)]
    [string]
    $Location = $Regions[0],
    # SCDM ID
    [Parameter(Mandatory = $true)]
    [string]
    $SCDMInputId
)


Describe "Azure ARM Template Unit Tests" {
    BeforeAll {
        $rgNamePrefix = 'SplunkDMDataIngest-'
        $consumerGroupName = "splk-resource-logs-consumer-group"
        $eventHubAuthRuleListen = "splk-resource-logs-eventhub-auth-listen"
        $eventHubAuthRuleSend = "splk-resource-logs-eventhub-auth-send"
        $eventHubName =  "splk-resource-logs-eventhub"
        $eventHubNamespaceNamePrefix =  "splkResLogsEH"
        $functionNamePrefix = "splkResLogsFn"

        $deploymentResult = Get-AzDeploymentWhatIfResult `
            -Name "UnitTestDeployment" `
            -Location $Location `
            -TemplateFile $TemplateFile `
            -TemplateParameterObject @{hecUrl = "http://localhost/"; hecToken = "i-am-a-token"; regions = $Regions; scdmInputId = $SCDMInputId; servicePrincipalObjectId = $ServicePrincipalObjectId; functionPackageURL = $FunctionPackageURL; resourceTags = @{tagKey = "tagValue"}}
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

            $resourceGroups.Count | Should -Be $regions.Count

            $rgNamesListExpected = @()

            foreach ($region in $regions) {
                $rgNameExpected = $rgNamePrefix + $SCDMInputId +  '-' + $region
                $rgNamesListExpected += $rgNameExpected
            }

            $rgNamesListActual = @()

            foreach($resourceGroup in $resourceGroups) {
                $resourceGroup.ChangeType | Should -Be "Create"
                $resourceGroup.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $resourceGroup.After["tags"]["tagKey"].Value | Should -Be "tagValue"
                $rgNamesListActual += $resourceGroup.After["name"].Value
            }

            # actual order of creation can't be guaranteed since resources are deployed in parallel
            # hence, comparing actual names observed with expected names without order
            $CompareRgNames = Compare-Object $rgNamesListActual $rgNamesListExpected -PassThru
            "$CompareRgNames" | Should -Be ""
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
            $resourceg = $resourceMap['Microsoft.Resources/resourceGroups'][0].After["id"].Value
            $resinfo = $resourceg.Split("/")
            $subscription ='/' + $resinfo[1] + '/' + $resinfo[2]

            $properties["assignableScopes"][0].Value | Should -Be $subscription

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
                "Microsoft.Storage/storageAccounts/blobServices/containers/read", `
                "Microsoft.Storage/storageAccounts/read", `
                "Microsoft.Web/sites/read", `
                "Microsoft.Web/serverfarms/read", `
                "Microsoft.Web/sites/sourcecontrols/read"

            $permissions[0].ContainsKey("dataActions") | Should -Be $true
            $dataActions = New-Object Collections.Generic.List[string]
            foreach($dataAction in $permissions[0]["dataActions"]) {
                $dataActions.Add($dataAction.Value)
            }
            $dataActions.ToArray() | Should -Be "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"
        }

        It "Role Assignments Created" {
            $roleAssignments = $resourceMap['Microsoft.Authorization/roleAssignments']

            $roleAssignments.Count | Should -Be $regions.Count

            foreach($roleAssignment in $roleAssignments) {
                $roleAssignment.ChangeType | Should -Be "Create"
                $properties = $roleAssignment.After["properties"]
                $properties["principalId"].Value | Should -Be $ServicePrincipalObjectId
                $properties["roleDefinitionId"].Value | Should -Be $resourceMap['Microsoft.Authorization/roleDefinitions'][0].After["id"].Value
            }
        }

        It "Eventhub Namespace Created" {
            $eventhubNamespaces = $resourceMap['Microsoft.EventHub/namespaces']
            $eventHubNamespaceNamePrefixPattern = $eventHubNamespaceNamePrefix + '*'

            $eventhubNamespaces.Count | Should -Be $regions.Count

            foreach($eventhubNamespace in $eventhubNamespaces) {
                $eventhubNamespace.ChangeType | Should -Be "Create"
                $eventhubNamespace.After["name"].Value | Should -BeLike $eventHubNamespaceNamePrefixPattern
                $eventhubNamespace.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $eventhubNamespace.After["tags"]["tagKey"].Value | Should -Be "tagValue"
                
                $properties = $eventhubNamespace.After["properties"]
                $properties["isAutoInflateEnabled"].Value | Should -BeTrue
                $properties["maximumThroughputUnits"].Value | Should -Be 40
                
                $sku = $eventhubNamespace.After["sku"]
                $sku["name"].Value | Should -Be "Standard"
            }
        }

        It "Eventhub Created" {
            $eventHubs = $resourceMap['Microsoft.EventHub/namespaces/eventhubs']

            $eventHubs.Count | Should -Be $regions.Count

            foreach($eventHub in $eventHubs) {
                $eventHub.ChangeType | Should -Be "Create"
                $eventHub.After["name"].Value | Should -Be $eventHubName
                
                $properties = $eventHub.After["properties"]
                $properties["partitionCount"].Value | Should -Be 32
            }
        }

        It "Consumer Group Created" {
            $consumerGroups = $resourceMap['Microsoft.EventHub/namespaces/eventhubs/consumergroups']

            $consumerGroups | Should -HaveCount $regions.Count

            foreach($consumergroup in $consumerGroups) {
                $consumerGroup.ChangeType | Should -Be "Create"
                $consumerGroup.After["name"].Value | Should -Be $consumerGroupName
            }
            
        }

        It "Authorization Rules Created" {
            $authRules = $resourceMap['Microsoft.EventHub/namespaces/AuthorizationRules']

            $authRules | Should -HaveCount (2 * $regions.Count)

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

            $storageAccounts | Should -HaveCount (3 * $regions.Count)
            foreach ($storageAccount in $storageAccounts) {
                $storageAccount.ChangeType | Should -Be "Create"
                $storageAccount.After["sku"]["name"].Value | Should -Be "Standard_LRS"
                $storageAccount.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $storageAccount.After["tags"]["tagKey"].Value | Should -Be "tagValue"
            }
        }

        It "App Service Plan Created" {
            $appServicePlans = $resourceMap['Microsoft.Web/serverfarms']

            $appServicePlans | Should -HaveCount $regions.Count

            foreach ($appServicePlan in $appServicePlans) {
                $appServicePlan.ChangeType | Should -Be "Create"
                $appServicePlan.After["kind"].Value | Should -Be "functionapp"
                $appServicePlan.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $appServicePlan.After["tags"]["tagKey"].Value | Should -Be "tagValue"
                $appServicePlan.After["sku"]["name"].Value | Should -Be "Y1"
                $appServicePlan.After["properties"]["reserved"].Value | Should -Be $true
            }
        }

        It "Function Created" {
            $functions = $resourceMap['Microsoft.Web/sites']

            $functions | Should -HaveCount $regions.Count

            $functionNamePrefixPattern = $functionNamePrefix + '*'

            foreach ($function in $appServicePlans) {
                $function.ChangeType | Should -Be "Create"
                $function.After["name"].Value | Should -BeLike $functionNamePrefixPattern
                $function.After["kind"].Value | Should -Be "functionapp,linux"
                $function.After["tags"]["SplunkDMInputId"].Value | Should -Be $SCDMInputId
                $function.After["tags"]["tagKey"].Value | Should -Be "tagValue"
            }
        }
    }
}