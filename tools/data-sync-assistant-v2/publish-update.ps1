param(
    [switch] $Upload,
    [string] $SourceCommit = ''
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$ProjectFile = Join-Path $ProjectDir "DataSyncAssistantV2.csproj"
$Executable = Join-Path $ProjectDir "bin\Release\Pms.DataSyncAssistant.V2.exe"
$MsBuild = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ProjectDir)
$ReleaseCheck = Join-Path $RepoRoot 'deploy/release-check.mjs'
if ($Upload) {
    if (-not $SourceCommit) { $SourceCommit = (& git -C $RepoRoot rev-parse HEAD).Trim() }
    if ($SourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'SourceCommit must be a full Git commit hash' }
    & node $ReleaseCheck check assistant $SourceCommit
    if ($LASTEXITCODE -ne 0) { throw '助手发布预检失败，尚未上传' }
}

& $MsBuild $ProjectFile /t:Rebuild /p:Configuration=Release /p:Platform=x86
if ($LASTEXITCODE -ne 0) { throw "PMS 数据同步助手构建失败" }

# 自检：不用 Start-Process -Wait（在部分 agent/非交互会话里会挂起），改用 Process API + 超时；
# 并把 TEMP/TMP 指到项目内目录：默认 Windows 8.3 短 TEMP（C:\Users\ADMINI~1\...）下
# WPF 自检会静默退出 1 且不写日志（已发布的 2.5.50 二进制同样复现），属构建环境问题。
$SelfTestTemp = Join-Path $ProjectDir "obj\self-test-temp"
New-Item -ItemType Directory -Force -Path $SelfTestTemp | Out-Null
$PreviousTemp = $env:TEMP
$PreviousTmp = $env:TMP
$env:TEMP = $SelfTestTemp
$env:TMP = $SelfTestTemp
try {
    $SelfTestInfo = New-Object System.Diagnostics.ProcessStartInfo
    $SelfTestInfo.FileName = $Executable
    $SelfTestInfo.Arguments = "--self-test"
    $SelfTestInfo.UseShellExecute = $false
    $SelfTestInfo.CreateNoWindow = $true
    $SelfTest = [System.Diagnostics.Process]::Start($SelfTestInfo)
    if (-not $SelfTest.WaitForExit(180000)) {
        try { $SelfTest.Kill() } catch { }
        throw "PMS 数据同步助手自检超时（180 秒）"
    }
    if ($SelfTest.ExitCode -ne 0) { throw "PMS 数据同步助手自检失败（退出码 $($SelfTest.ExitCode)）" }
}
finally {
    $env:TEMP = $PreviousTemp
    $env:TMP = $PreviousTmp
}

if ($Upload) {
    $EvidenceDirectory = Join-Path $RepoRoot ('artifacts/release-checks/assistant-installation-' + $SourceCommit.Substring(0, 8))
    & (Join-Path $ProjectDir 'verify-installation.ps1') -EvidenceDirectory $EvidenceDirectory
    if ($LASTEXITCODE -ne 0) { throw '助手真实 SCM 安装/回退冒烟失败，停止上传' }
    Copy-Item -LiteralPath (Join-Path $SelfTestTemp 'PmsDataSyncAssistant-self-test.log') -Destination (Join-Path $EvidenceDirectory 'assistant-self-test.txt')
}

$Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).FileVersion
$ShortVersion = ([Version]$Version).ToString(3)
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash.ToLowerInvariant()
$ReleaseRoot = Join-Path $ProjectDir "release"
$VersionDir = Join-Path $ReleaseRoot $ShortVersion
New-Item -ItemType Directory -Force -Path $VersionDir | Out-Null
$ReleaseExecutable = Join-Path $VersionDir "Pms.DataSyncAssistant.V2.exe"
Copy-Item -Force -LiteralPath $Executable -Destination $ReleaseExecutable
$SetupExecutable = Join-Path $VersionDir 'Pms.DataSyncAssistant.Setup.exe'
Copy-Item -Force -LiteralPath $Executable -Destination $SetupExecutable

$Manifest = [ordered]@{
    version = $ShortVersion
    # 同时写入新旧字段，保证 2.5.1/2.5.3 均能一键升级。
    downloadUrl = "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.V2.exe"
    url = "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.V2.exe"
    installerUrl = "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.Setup.exe"
    sha256 = $Hash
    releaseNotes = "PMS 数据同步助手 ${ShortVersion}：固定安装入口、统一升级事务、就绪验证与可靠回退；保留配置及密码，安全清理旧程序。"
    notes = "PMS 数据同步助手 ${ShortVersion}：固定安装入口、统一升级事务、就绪验证与可靠回退；保留配置及密码，安全清理旧程序。"
    publishedAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceCommit = $SourceCommit
} | ConvertTo-Json
$Utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $ReleaseRoot "latest.json"), $Manifest, $Utf8WithoutBom)

Write-Host "已生成安装程序：$SetupExecutable" -ForegroundColor Green
Write-Host "兼容旧版更新包：$ReleaseExecutable" -ForegroundColor Green
Write-Host "SHA-256：$Hash"

if (-not $Upload) {
    Write-Host "未上传生产。审核通过后使用 -Upload 参数发布。" -ForegroundColor Yellow
    exit 0
}

$Remote = "ubuntu@124.223.179.214"
& node $ReleaseCheck verify-source assistant $SourceCommit
if ($LASTEXITCODE -ne 0) { throw '构建期间源码改变，停止上传' }
$Key = Join-Path $env:USERPROFILE ".ssh\pms_repair_key.pem"
$RemoteTemporary = "/tmp/pms-data-sync-assistant-$ShortVersion"
& ssh -i $Key $Remote "mkdir -p '$RemoteTemporary'"
if ($LASTEXITCODE -ne 0) { throw "无法创建服务器临时目录" }
& scp -i $Key $ReleaseExecutable "${Remote}:$RemoteTemporary/Pms.DataSyncAssistant.V2.exe"
if ($LASTEXITCODE -ne 0) { throw "新版程序上传失败" }
& scp -i $Key (Join-Path $ReleaseRoot "latest.json") "${Remote}:$RemoteTemporary/latest.json"
if ($LASTEXITCODE -ne 0) { throw "更新清单上传失败" }

# Payloads first; publish manifest with a same-filesystem rename, retaining the previous manifest for operator rollback.
$RemoteCommand = "set -e; base=/opt/pms-repair/downloads/pms-data-sync-assistant; echo '$Hash  $RemoteTemporary/Pms.DataSyncAssistant.V2.exe' | sha256sum -c -; sudo mkdir -p `$base/$ShortVersion; for name in Pms.DataSyncAssistant.V2.exe Pms.DataSyncAssistant.Setup.exe; do if test -f `$base/$ShortVersion/`$name; then echo '$Hash  '`$base/$ShortVersion/`$name | sha256sum -c -; fi; done; sudo install -m 0644 '$RemoteTemporary/Pms.DataSyncAssistant.V2.exe' `$base/$ShortVersion/Pms.DataSyncAssistant.V2.exe; sudo install -m 0644 '$RemoteTemporary/Pms.DataSyncAssistant.V2.exe' `$base/$ShortVersion/Pms.DataSyncAssistant.Setup.exe; if test -f `$base/latest.json; then sudo cp -p `$base/latest.json `$base/latest.previous.json; fi; sudo install -m 0644 '$RemoteTemporary/latest.json' `$base/latest.$ShortVersion.new; sudo mv -f `$base/latest.$ShortVersion.new `$base/latest.json"
& ssh -i $Key $Remote $RemoteCommand
if ($LASTEXITCODE -ne 0) { throw "生产更新包发布失败" }

# HTTP 200 不代表发布生效：Nginx 可能仍从 Web 目录返回旧清单。
# 必须同时核对公网清单版本、哈希以及实际下载文件。
$ManifestUri = 'https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json?verify=' + [Uri]::EscapeDataString((Get-Date).ToUniversalTime().ToString('o'))
$OnlineManifest = Invoke-RestMethod -Uri $ManifestUri -Headers @{'Cache-Control' = 'no-cache'}
if ($OnlineManifest.version -ne $ShortVersion -or $OnlineManifest.sha256 -ne $Hash -or $OnlineManifest.sourceCommit -ne $SourceCommit -or
    $OnlineManifest.installerUrl -ne "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.Setup.exe") {
    throw "线上更新清单仍不是本次版本：期望 $ShortVersion / $Hash，实际 $($OnlineManifest.version) / $($OnlineManifest.sha256)"
}
$PublicExecutable = [IO.Path]::GetTempFileName()
try {
    foreach ($DownloadUri in @($OnlineManifest.url, $OnlineManifest.installerUrl)) {
        Invoke-WebRequest -Uri $DownloadUri -OutFile $PublicExecutable -Headers @{'Cache-Control' = 'no-cache'}
        $PublicHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PublicExecutable).Hash.ToLowerInvariant()
        if ($PublicHash -ne $Hash) { throw "公网下载文件校验失败：$DownloadUri / $PublicHash" }
        if ([Diagnostics.FileVersionInfo]::GetVersionInfo($PublicExecutable).FileVersion -ne $Version) { throw '公网安装包文件版本不一致' }
    }
}
finally {
    if (Test-Path -LiteralPath $PublicExecutable -PathType Leaf) {
        $ResolvedTemporary = (Resolve-Path -LiteralPath $PublicExecutable).Path
        if ($ResolvedTemporary -ne [IO.Path]::GetFullPath($PublicExecutable) -or
            (Split-Path -Parent $ResolvedTemporary) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')) {
            throw 'Refusing to remove an unexpected verification temporary file'
        }
        Remove-Item -Force -LiteralPath $ResolvedTemporary
    }
}
Write-Host "PMS 数据同步助手 $ShortVersion 已发布。" -ForegroundColor Green
