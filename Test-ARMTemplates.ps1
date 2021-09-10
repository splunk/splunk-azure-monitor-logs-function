function Test-ARMTemplates {
    [CmdletBinding()]
    param (
        [Parameter()]
        [string]
        $TemplateFolder
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

        function Invoke-Tests {
            [CmdletBinding()]
            param (
                [Parameter()]
                [string]
                $TemplateFile
            )

            process {
                Write-Information -MessageData "Running tests on $TemplateFile" -InformationAction Continue
                $testResults = Test-AzTemplate -TemplatePath $TemplateFile
                Write-Information -MessageData "Test Complete" -InformationAction Continue
                $failures = $testResults | Where-Object { -not $_.Passed }
                $failCount = ($failures | Measure-Object).Count
                Write-Information -MessageData "Test failures: $failCount" -InformationAction Continue
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
            $failCount += Invoke-Tests -TemplateFile $template
        }

        exit($failCount)
    }
}