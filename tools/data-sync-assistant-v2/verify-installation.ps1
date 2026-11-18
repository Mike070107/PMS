param([string] $EvidenceDirectory = '')
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '真实 SCM 冒烟需要管理员权限；不会修改生产服务或现场连接。'
}
$executable = Join-Path $PSScriptRoot 'bin\Release\Pms.DataSyncAssistant.V2.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw '请先执行 publish-update.ps1 构建并自检。' }
$temporary = Join-Path $PSScriptRoot 'obj\self-test-temp'
New-Item -ItemType Directory -Force -Path $temporary | Out-Null
$root = Join-Path $temporary ('PmsAssistantScmTest-' + [guid]::NewGuid().ToString('N'))
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$env:TEMP = $temporary
$env:TMP = $temporary
try {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $executable
    $info.Arguments = '--installation-scm-self-test "' + $root + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($info)
    if (-not $process.WaitForExit(150000)) {
        # Do not kill the orchestrator mid-transaction: retain the isolated service for diagnosis.
        throw "隔离 SCM 冒烟超时，测试仍在运行，PID=$($process.Id)，诊断目录=$root"
    }
    if ($process.ExitCode -ne 0) { throw "SCM 冒烟失败（退出码 $($process.ExitCode)），请检查 $root" }
    $result = Join-Path $root 'scm-test-result.txt'
    if (-not (Test-Path -LiteralPath $result)) { throw 'SCM 冒烟未产生成功证据' }
    Write-Host "真实 Windows SCM 冒烟通过，证据：$result" -ForegroundColor Green
    if ($EvidenceDirectory) {
        New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
        Copy-Item -LiteralPath $result -Destination (Join-Path $EvidenceDirectory 'assistant-scm-test.txt') -Force
        [ordered]@{ version=[Diagnostics.FileVersionInfo]::GetVersionInfo($executable).FileVersion;
            sha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();
            testedAt=(Get-Date).ToUniversalTime().ToString('o'); testRoot=$root
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'assistant-scm-test.json') -Encoding UTF8
    }
}
finally { $env:TEMP = $previousTemp; $env:TMP = $previousTmp }
