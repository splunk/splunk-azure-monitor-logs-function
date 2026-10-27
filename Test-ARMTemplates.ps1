function Test-ARMTemplates {
    [CmdletBinding()]
    param (
        [Parameter()]
        [string]
        $TemplateFolder,
        # Run unit tests
        [Parameter()]
        [switch]
        $UnitTests,
        # Run in CI
        [Parameter()]
        [switch]
        $CI,
        # Azure ID
        [Parameter()]
        [string]
        $AzureId,
        # Azure Tenant
        [Parameter()]
        [string]
        $AzureTenant,
        # Azure Token
        [Parameter()]
        [string]
        $AzureToken
    )

    begin {
        # Keep validation tooling reproducible. Update these pins deliberately
        # and validate the pipeline before changing them.
        $ToolkitVersion = "0ec9a41a4503e970a0ec8efb0cd08415cc172175"
        $PesterVersion = "5.9.1"
        $AzAccountsVersion = "5.5.3"
        $AzResourcesVersion = "9.1.0"

        function Install-ARMTestToolkit {
            process {
                $toolkitLink = "https://github.com/Azure/arm-ttk/archive/$ToolkitVersion.zip"
                $cacheRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData', 'Create')) "azure-monitor-logs"
                $destinationPath = Join-Path $cacheRoot "arm-ttk-$ToolkitVersion"
                $toolkitModule = Get-ChildItem -Path $destinationPath -Filter "arm-ttk.psd1" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

                if (-not $toolkitModule) {
                    Write-Verbose -Message "Downloading ARM test toolkit"
                    if (Test-Path $destinationPath) {
                        Remove-Item -Path $destinationPath -Recurse -Force -ErrorAction Stop
                    }
                    New-Item -Path $destinationPath -ItemType Directory -Force -ErrorAction Stop | Out-Null
                    $zipFile = Join-Path $destinationPath "arm-ttk-$ToolkitVersion.zip"
                    Invoke-WebRequest -Uri $toolkitLink -OutFile $zipFile -ErrorAction Stop
                    Write-Verbose -Message "Extracting ARM test toolkit"
                    Expand-Archive -Path $zipFile -DestinationPath $destinationPath -ErrorAction Stop
                    $toolkitModule = Get-ChildItem -Path $destinationPath -Filter "arm-ttk.psd1" -File -Recurse -ErrorAction Stop | Select-Object -First 1
                }

                if (-not $toolkitModule) {
                    throw "Pinned ARM-TTK archive $ToolkitVersion did not contain arm-ttk.psd1."
                }
                Import-Module $toolkitModule.FullName -Force -ErrorAction Stop
                if (-not (Get-Command Test-AzTemplate -ErrorAction SilentlyContinue)) {
                    throw "ARM-TTK imported, but Test-AzTemplate is unavailable."
                }
            }
        }

        function Invoke-ValidationTests {
            [CmdletBinding()]
            param (
                [Parameter()]
                [string]
                $TemplateFile
            )

            process {
                Write-Information -MessageData "Running validation tests on $TemplateFile" -InformationAction Continue
                # As we cannot update apiVersions to 2 years old max the tests validating it will be skipped for patch release
                $testResults = Test-AzTemplate -Skip 'apiVersions-Should-Be-Recent','apiVersions-Should-Be-Recent-In-Reference-Functions' -TemplatePath $TemplateFile
                Write-Information -MessageData "Test Complete" -InformationAction Continue
                $failures = $testResults | Where-Object { -not $_.Passed }
                $failCount = ($failures | Measure-Object).Count
                Write-Information -MessageData "Test failures: $failCount" -InformationAction Continue
                if ($failCount -ne 0) {
                    $failures | Format-Table -Property Errors, Name, Group | Out-String | Write-Information -InformationAction Continue
                }
                return $failCount
            }
        }

        function Invoke-UnitTests {
            [CmdletBinding()]
            param (
                [Parameter()]
                [string]
                $TemplateFile
            )

            process {
                Write-Information -MessageData "Running unit tests on $TemplateFile" -InformationAction Continue
                Write-Information -MessageData "Locating unit tests for $TemplateFile" -InformationAction Continue
                $templateFolder = Split-Path -Path $TemplateFile
                $testFolder = Join-Path -Path $templateFolder -ChildPath "tests"
                $tests = Get-ChildItem -Path $testFolder -Filter *.Tests.ps1
                $failCount = 0

                foreach ($test in $tests) {
                    Write-Information -MessageData "Discovered script $test" -InformationAction Continue
                    $SCDMId = New-Guid
                    $container = New-PesterContainer -Path $test -Data @{ SCDMInputId = $SCDMId; TemplateFile = $TemplateFile }
                    $testResult = Invoke-Pester -Container $container -PassThru
                    Write-Information -MessageData "Test Complete" -InformationAction Continue
                    $passed = $testResult.PassedCount
                    $failed = $testResult.FailedCount
                    $failCount += $failed
                    Write-Information -MessageData "Tests Passed: $passed" -InformationAction Continue
                    Write-Information -MessageData "Tests Failed: $failed" -InformationAction Continue
                    if ($failed -ne 0) {
                        $testResult.Failed | Format-Table -Property Name, Result, ErrorRecord | Out-String | Write-Information -InformationAction Continue
                    }
                }

                return $failCount
            }
        }
    }

    process {
        Install-ARMTestToolkit
        $templates = Get-ChildItem -Path $TemplateFolder -Recurse -Filter *.json
        Write-Verbose -Message "Found templates $templates"
        $failCount = 0
        foreach ($template in $templates) {
            $failCount += Invoke-ValidationTests -TemplateFile $template
        }

        if ($UnitTests -eq $true) {
            if ($CI -eq $true) {
                if (-not (Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [version]$PesterVersion })) {
                    Write-Information -MessageData "Installing Pester $PesterVersion ..." -InformationAction Continue
                    Install-Module -Name Pester -RequiredVersion $PesterVersion -Scope CurrentUser -Repository PSGallery -Force -ErrorAction Stop
                }
                Import-Module Pester -RequiredVersion $PesterVersion -Force -ErrorAction Stop

                if (-not (Get-Module -ListAvailable -Name Az.Accounts | Where-Object { $_.Version -eq [version]$AzAccountsVersion })) {
                    Write-Information -MessageData "Installing Az.Accounts $AzAccountsVersion ..." -InformationAction Continue
                    Install-Module -Name Az.Accounts -RequiredVersion $AzAccountsVersion -Scope CurrentUser -Repository PSGallery -Force -ErrorAction Stop
                }
                Import-Module Az.Accounts -RequiredVersion $AzAccountsVersion -Force -ErrorAction Stop

                if (-not (Get-Module -ListAvailable -Name Az.Resources | Where-Object { $_.Version -eq [version]$AzResourcesVersion })) {
                    Write-Information -MessageData "Installing Az.Resources $AzResourcesVersion ..." -InformationAction Continue
                    Install-Module -Name Az.Resources -RequiredVersion $AzResourcesVersion -Scope CurrentUser -Repository PSGallery -Force -ErrorAction Stop
                }
                Import-Module Az.Resources -RequiredVersion $AzResourcesVersion -Force -ErrorAction Stop
                if (-not (Get-Command Get-AzDeploymentWhatIfResult -ErrorAction SilentlyContinue)) {
                    throw "Az.Resources $AzResourcesVersion imported, but Get-AzDeploymentWhatIfResult is unavailable."
                }

                $User = $AzureId
                $PWord = ConvertTo-SecureString -String $AzureToken -AsPlainText -Force
                $Credential = New-Object -TypeName "System.Management.Automation.PSCredential" -ArgumentList $User, $PWord
                Connect-AzAccount -Credential $Credential -Tenant $AzureTenant -ServicePrincipal
            }

            foreach ($template in $templates) {
                $failCount += Invoke-UnitTests -TemplateFile $template
            }
        }

        exit($failCount)
    }
}
