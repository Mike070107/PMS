#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:ProgramData 'PMSGateway'
$taskName = 'PMS Domestic Gateway'
$required = @('frpc.exe', 'frpc.toml', 'frp-token')

foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $name))) {
    throw "安装包不完整：缺少 $name"
  }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
  Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force

Copy-Item -LiteralPath (Join-Path $source 'frpc.exe') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'frpc.toml') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'frp-token') -Destination $target -Force

$exe = Join-Path $target 'frpc.exe'
$config = Join-Path $target 'frpc.toml'
$action = New-ScheduledTaskAction -Execute $exe -Argument "-c `"$config`"" -WorkingDirectory $target
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 3
$task = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "PMS 内网代理已安装并启动。" -ForegroundColor Green
Write-Host "运行状态: $($task.LastTaskResult)"
Write-Host "安装目录: $target"
