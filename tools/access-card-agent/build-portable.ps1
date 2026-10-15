param(
  [string]$OutputDirectory = "$PSScriptRoot\release",
  [string]$SignerThumbprint = ''
)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$profileSeed = Join-Path $PSScriptRoot 'access-card-profiles.seed'
if (-not (Test-Path -LiteralPath $profileSeed)) { throw '缺少本机卡片模板 access-card-profiles.seed，拒绝生成不可用的正式助手' }
$msbuild = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"
& $msbuild "$PSScriptRoot\AccessCardAgent.csproj" /p:Configuration=Release /p:Platform=x86 /p:OutputPath="$OutputDirectory\build\"
if ($LASTEXITCODE -ne 0) { throw '发卡助手构建失败' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$built = Join-Path $OutputDirectory 'build\Pms.DataSyncAssistant.exe'
if (-not [string]::IsNullOrWhiteSpace($SignerThumbprint)) {
  $signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if (-not $signTool) { throw '已指定签名证书，但未找到 Windows SDK signtool.exe' }
  $normalizedThumbprint = $SignerThumbprint.Replace(' ', '')
  & $signTool.Source sign /sha1 $normalizedThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $built
  if ($LASTEXITCODE -ne 0) { throw '发卡助手代码签名失败' }
}
Copy-Item -LiteralPath $built -Destination (Join-Path $OutputDirectory 'Pms.AccessCardAssistant.exe') -Force
Copy-Item -LiteralPath $built -Destination (Join-Path $OutputDirectory '枫桦景苑门禁卡加密初始化助手.exe') -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutputDirectory 'Pms.AccessCardAssistant.exe')).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  version = '0.9.0'
  downloadUrl = 'https://prsznh.cn/downloads/pms-access-card-assistant/0.9.0/Pms.AccessCardAssistant.exe'
  sha256 = $hash
  signerThumbprint = $SignerThumbprint.Replace(' ', '')
  releaseNotes = '独立批量初始化；PMS 发卡仅接受已初始化卡；捷顺入库与回读。'
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'latest.json') -Encoding UTF8
Write-Host "Portable assistants created in $OutputDirectory"
