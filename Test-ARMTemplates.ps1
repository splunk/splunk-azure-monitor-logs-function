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
        function Install-ARMTestToolkit {
            process {
                $ToolkitLink = "https://aka.ms/arm-ttk-latest"
                $ZipFile = "arm-ttk-latest.zip"
                $destinationPath = "arm-ttk-latest"

                if (!(Test-Path $ZipFile -PathType Leaf) -and !(Test-Path $destinationPath)) {
                    Write-Verbose -Message "Downloading ARM test toolkit"
                    Invoke-WebRequest -Uri $ToolkitLink -OutFile $ZipFile
                    Write-Verbose -Message "Extracting ARM test toolkit"
                    Expand-Archive -Path $ZipFile -DestinationPath $destinationPath
                }

                Import-Module "./arm-ttk-latest/arm-ttk/arm-ttk.psd1"
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
                if ( -not (Get-Module -ListAvailable -Name Pester)) {
                    #  Install Pester
                    Write-Information -MessageData "Installing Pester ..." -InformationAction Continue
                    Install-Module -Name Pester -Force
                }

                if ( -not (Get-Module -ListAvailable -Name Az)) {
                    # Install  Az
                    Write-Information -MessageData "Installing Az ..." -InformationAction Continue
                    Install-Module -Name Az -Scope CurrentUser -Repository PSGallery -Force
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
