param(
  [Parameter(Mandatory = $true)][string]$FrpcArchive,
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$expectedSha256 = '9E5062E3E5CF07E67144A3A4ACF175EF6A2486F3605DD6CF288BAE34AB39819F'
$actualSha256 = (Get-FileHash -LiteralPath $FrpcArchive -Algorithm SHA256).Hash
if ($actualSha256 -ne $expectedSha256) {
  throw "frpc archive SHA-256 mismatch: $actualSha256"
}

$token = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
if ($token -notmatch '^[a-f0-9]{64}$') {
  throw 'FRP token file is invalid'
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("pms-gateway-agent-" + [guid]::NewGuid().ToString('N'))
$expanded = Join-Path $work 'expanded'
$package = Join-Path $work 'PMS-Domestic-Gateway'
New-Item -ItemType Directory -Force -Path $expanded, $package | Out-Null

try {
  Expand-Archive -LiteralPath $FrpcArchive -DestinationPath $expanded -Force
  $frpc = Get-ChildItem -Path $expanded -Recurse -Filter frpc.exe | Select-Object -First 1
  if (-not $frpc) { throw 'frpc.exe not found in archive' }

  Copy-Item -LiteralPath $frpc.FullName -Destination (Join-Path $package 'frpc.exe')
  # Windows PowerShell 5 treats UTF-8 without BOM as the system ANSI code page.
  # Re-encode the user-facing scripts with BOM so Chinese messages cannot corrupt parsing.
  $utf8Bom = [System.Text.UTF8Encoding]::new($true)
  foreach ($scriptName in @('install.ps1', 'uninstall.ps1')) {
    $sourceScript = Join-Path $root "windows\$scriptName"
    $scriptText = [System.IO.File]::ReadAllText(
      $sourceScript,
      [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText((Join-Path $package $scriptName), $scriptText, $utf8Bom)
  }
  Set-Content -LiteralPath (Join-Path $package 'frp-token') -Value $token -NoNewline -Encoding ascii

  $config = @'
serverAddr = "124.223.179.214"
serverPort = 7000
loginFailExit = false

auth.method = "token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "C:/ProgramData/PMSGateway/frp-token"

transport.protocol = "tcp"
transport.tls.enable = true
transport.tcpMux = true
transport.poolCount = 10

log.to = "C:/ProgramData/PMSGateway/frpc.log"
log.level = "info"
log.maxDays = 14

[[proxies]]
name = "caiwu"
type = "tcp"
localIP = "192.168.110.251"
localPort = 8050
remotePort = 18050
transport.useEncryption = true
transport.useCompression = true
'@
  [System.IO.File]::WriteAllText(
    (Join-Path $package 'frpc.toml'),
    $config,
    [System.Text.UTF8Encoding]::new($false)
  )

  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
  if (Test-Path -LiteralPath $resolvedOutput) {
    Remove-Item -LiteralPath $resolvedOutput -Force
  }
  Compress-Archive -Path (Join-Path $package '*') -DestinationPath $resolvedOutput -CompressionLevel Optimal
  Write-Host "Created agent package: $resolvedOutput"
} finally {
  if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
}
