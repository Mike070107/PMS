param(
    [int] $Keep = 3,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if ($Keep -lt 1) { throw 'Keep 必须至少为 1' }

foreach ($prefix in @('pms-api-', 'pms-web-')) {
    $packages = @(Get-ChildItem (Join-Path $RepoRoot 'deploy') -File -Filter ($prefix + '*.tar.gz') |
        Sort-Object LastWriteTime -Descending)
    Write-Host ("$prefix 共 " + $packages.Count + ' 个，本次保留最近 ' + $Keep + ' 个')
    foreach ($old in ($packages | Select-Object -Skip $Keep)) {
        if ($WhatIf) {
            Write-Host ('[预览] 删除 ' + $old.Name)
        } else {
            Remove-Item -LiteralPath $old.FullName -Force
            Write-Host ('已删除 ' + $old.Name)
        }
    }
}
