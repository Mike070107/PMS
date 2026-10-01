#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$taskName = 'PMS Domestic Gateway'
$target = Join-Path $env:ProgramData 'PMSGateway'

Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
  Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
Write-Host "PMS 内网代理已卸载。" -ForegroundColor Green
