$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'publish-production.ps1'
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if ($errors) { throw ($errors | Out-String) }
foreach ($name in @('Die','Run')) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if (-not $definition) { throw "missing function $name" }
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
$script:ReleasePhases = [Collections.Generic.List[object]]::new()
$LASTEXITCODE = 0
Run 'native stderr with successful exit is not a deployment failure' { node -e "console.error('ordinary native build output');process.exit(0)" }
if (-not $script:ReleasePhases[0].passed) { throw 'successful native command was rejected' }
$caught = $false
try { Run 'nonzero native exit must fail' { node -e 'process.exit(7)' } } catch { $caught = $true }
if (-not $caught -or $script:ReleasePhases[1].passed) { throw 'nonzero exit was not rejected' }
$LASTEXITCODE = 0
$caught = $false
try { Run 'PowerShell errors must fail even if native exit is zero' { Write-Error 'synthetic PowerShell failure'; node -e 'process.exit(0)' } } catch { $caught = $true }
if (-not $caught -or $script:ReleasePhases[2].passed) { throw 'PowerShell error was swallowed' }
if ($ErrorActionPreference -ne 'Stop') { throw 'error preference leaked out of runner' }
Write-Host 'Native runner regression: 3/3 passed; original error preference restored.'
