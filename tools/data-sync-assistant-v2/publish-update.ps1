param(
    [switch] $Upload
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$ProjectFile = Join-Path $ProjectDir "DataSyncAssistantV2.csproj"
$Executable = Join-Path $ProjectDir "bin\Release\Pms.DataSyncAssistant.V2.exe"
$MsBuild = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"

& $MsBuild $ProjectFile /t:Rebuild /p:Configuration=Release /p:Platform=x86
if ($LASTEXITCODE -ne 0) { throw "PMS 数据同步助手构建失败" }

$SelfTest = Start-Process -FilePath $Executable -ArgumentList "--self-test" -Wait -PassThru
if ($SelfTest.ExitCode -ne 0) { throw "PMS 数据同步助手自检失败" }

$Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).FileVersion
$ShortVersion = ([Version]$Version).ToString(3)
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash.ToLowerInvariant()
$ReleaseRoot = Join-Path $ProjectDir "release"
$VersionDir = Join-Path $ReleaseRoot $ShortVersion
New-Item -ItemType Directory -Force -Path $VersionDir | Out-Null
$ReleaseExecutable = Join-Path $VersionDir "Pms.DataSyncAssistant.V2.exe"
Copy-Item -Force -LiteralPath $Executable -Destination $ReleaseExecutable

$Manifest = [ordered]@{
    version = $ShortVersion
    # 同时写入新旧字段，保证 2.5.1/2.5.3 均能一键升级。
    downloadUrl = "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.V2.exe"
    url = "https://prsznh.cn/downloads/pms-data-sync-assistant/$ShortVersion/Pms.DataSyncAssistant.V2.exe"
    sha256 = $Hash
    releaseNotes = "PMS 数据同步助手 $ShortVersion"
    notes = "PMS 数据同步助手 $ShortVersion"
    publishedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json
$Utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $ReleaseRoot "latest.json"), $Manifest, $Utf8WithoutBom)

Write-Host "已生成更新包：$ReleaseExecutable" -ForegroundColor Green
Write-Host "SHA-256：$Hash"

if (-not $Upload) {
    Write-Host "未上传生产。审核通过后使用 -Upload 参数发布。" -ForegroundColor Yellow
    exit 0
}

$Remote = "ubuntu@124.223.179.214"
$Key = Join-Path $env:USERPROFILE ".ssh\pms_repair_key.pem"
$RemoteTemporary = "/tmp/pms-data-sync-assistant-$ShortVersion"
& ssh -i $Key $Remote "mkdir -p '$RemoteTemporary'"
if ($LASTEXITCODE -ne 0) { throw "无法创建服务器临时目录" }
& scp -i $Key $ReleaseExecutable "${Remote}:$RemoteTemporary/Pms.DataSyncAssistant.V2.exe"
if ($LASTEXITCODE -ne 0) { throw "新版程序上传失败" }
& scp -i $Key (Join-Path $ReleaseRoot "latest.json") "${Remote}:$RemoteTemporary/latest.json"
if ($LASTEXITCODE -ne 0) { throw "更新清单上传失败" }

$RemoteCommand = "set -e; base=/opt/pms-repair/downloads/pms-data-sync-assistant; sudo mkdir -p `$base/$ShortVersion; sudo install -m 0644 '$RemoteTemporary/Pms.DataSyncAssistant.V2.exe' `$base/$ShortVersion/Pms.DataSyncAssistant.V2.exe; sudo install -m 0644 '$RemoteTemporary/latest.json' `$base/latest.json"
& ssh -i $Key $Remote $RemoteCommand
if ($LASTEXITCODE -ne 0) { throw "生产更新包发布失败" }

# HTTP 200 不代表发布生效：Nginx 可能仍从 Web 目录返回旧清单。
# 必须同时核对公网清单版本、哈希以及实际下载文件。
$ManifestUri = 'https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json?verify=' + [Uri]::EscapeDataString((Get-Date).ToUniversalTime().ToString('o'))
$OnlineManifest = Invoke-RestMethod -Uri $ManifestUri -Headers @{'Cache-Control' = 'no-cache'}
if ($OnlineManifest.version -ne $ShortVersion -or $OnlineManifest.sha256 -ne $Hash) {
    throw "线上更新清单仍不是本次版本：期望 $ShortVersion / $Hash，实际 $($OnlineManifest.version) / $($OnlineManifest.sha256)"
}
$PublicExecutable = [IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $OnlineManifest.url -OutFile $PublicExecutable -Headers @{'Cache-Control' = 'no-cache'}
    $PublicHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PublicExecutable).Hash.ToLowerInvariant()
    if ($PublicHash -ne $Hash) { throw "公网下载文件校验失败：$PublicHash" }
}
finally {
    Remove-Item -Force -LiteralPath $PublicExecutable -ErrorAction SilentlyContinue
}
Write-Host "PMS 数据同步助手 $ShortVersion 已发布。" -ForegroundColor Green
