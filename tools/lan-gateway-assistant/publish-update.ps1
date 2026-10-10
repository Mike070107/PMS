param([switch] $Upload)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$ProjectFile = Join-Path $ProjectDir "PmsLanGatewayAssistant.csproj"
$Executable = Join-Path $ProjectDir "bin\Release\Pms.LanGatewayAssistant.exe"
$MsBuild = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"

& $MsBuild $ProjectFile /t:Rebuild /p:Configuration=Release /p:Platform=x86
if ($LASTEXITCODE -ne 0) { throw "PMS 内网应用连接助手构建失败" }
$SelfTest = Start-Process -FilePath $Executable -ArgumentList "--self-test" -Wait -PassThru
if ($SelfTest.ExitCode -ne 0) { throw "PMS 内网应用连接助手自检失败" }

$Version = ([Version][Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).FileVersion).ToString(3)
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash.ToLowerInvariant()
$ReleaseRoot = Join-Path $ProjectDir "release"
$VersionDir = Join-Path $ReleaseRoot $Version
New-Item -ItemType Directory -Force -Path $VersionDir | Out-Null
$ReleaseExecutable = Join-Path $VersionDir "Pms.LanGatewayAssistant.exe"
Copy-Item -Force -LiteralPath $Executable -Destination $ReleaseExecutable
$Manifest = [ordered]@{
    version = $Version
    url = "https://prsznh.cn/downloads/pms-lan-gateway-assistant/$Version/Pms.LanGatewayAssistant.exe"
    sha256 = $Hash
    notes = "PMS 内网应用连接助手 $Version：后台服务每六小时静默检查、校验并安全更新，失败自动恢复旧版"
    publishedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json
$Utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $ReleaseRoot "latest.json"), $Manifest, $Utf8WithoutBom)
Write-Host "已生成更新制品：$ReleaseExecutable" -ForegroundColor Green

if (-not $Upload) { Write-Host "未上传生产。获得明确生产发布授权后使用 -Upload。" -ForegroundColor Yellow; exit 0 }

$Remote = "ubuntu@124.223.179.214"
$Key = Join-Path $env:USERPROFILE ".ssh\pms_repair_key.pem"
$RemoteTemporary = "/tmp/pms-lan-gateway-assistant-$Version"
& ssh -i $Key $Remote "mkdir -p '$RemoteTemporary'"
if ($LASTEXITCODE -ne 0) { throw "无法创建服务器临时目录" }
& scp -i $Key $ReleaseExecutable "${Remote}:$RemoteTemporary/Pms.LanGatewayAssistant.exe"
if ($LASTEXITCODE -ne 0) { throw "新版程序上传失败" }
& scp -i $Key (Join-Path $ReleaseRoot "latest.json") "${Remote}:$RemoteTemporary/latest.json"
if ($LASTEXITCODE -ne 0) { throw "更新清单上传失败" }
$RemoteCommand = "set -e; base=/opt/pms-repair/downloads/pms-lan-gateway-assistant; sudo mkdir -p `$base/$Version; sudo install -m 0644 '$RemoteTemporary/Pms.LanGatewayAssistant.exe' `$base/$Version/Pms.LanGatewayAssistant.exe; sudo install -m 0644 '$RemoteTemporary/latest.json' `$base/latest.json"
& ssh -i $Key $Remote $RemoteCommand
if ($LASTEXITCODE -ne 0) { throw "生产更新包发布失败" }

$Online = Invoke-RestMethod -Uri ("https://prsznh.cn/downloads/pms-lan-gateway-assistant/latest.json?verify=" + [Uri]::EscapeDataString((Get-Date).ToUniversalTime().ToString("o"))) -Headers @{ "Cache-Control" = "no-cache" }
if ($Online.version -ne $Version -or $Online.sha256 -ne $Hash) { throw "线上更新清单不是本次版本" }
$Download = [IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $Online.url -OutFile $Download -Headers @{ "Cache-Control" = "no-cache" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Download).Hash.ToLowerInvariant() -ne $Hash) { throw "公网下载文件校验失败" }
}
finally { Remove-Item -Force -LiteralPath $Download -ErrorAction SilentlyContinue }
Write-Host "PMS 内网应用连接助手 $Version 已发布。" -ForegroundColor Green
