param(
    [string] $FrpcArchive
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$ProjectFile = Join-Path $ProjectDir "PmsLanGatewayAssistant.csproj"
$Executable = Join-Path $ProjectDir "bin\Release\Pms.LanGatewayAssistant.exe"
$MsBuild = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"
$ExpectedFrpcHash = "9E5062E3E5CF07E67144A3A4ACF175EF6A2486F3605DD6CF288BAE34AB39819F"

& $MsBuild $ProjectFile /t:Rebuild /p:Configuration=Release /p:Platform=x86
if ($LASTEXITCODE -ne 0) { throw "PMS 内网应用连接助手构建失败" }
$SelfTest = Start-Process -FilePath $Executable -ArgumentList "--self-test" -Wait -PassThru
if ($SelfTest.ExitCode -ne 0) { throw "PMS 内网应用连接助手自检失败" }

$Version = ([Version][Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).FileVersion).ToString(3)
$ReleaseRoot = Join-Path $ProjectDir "release"
$Stage = Join-Path $ReleaseRoot ("package-" + $Version)
if (Test-Path -LiteralPath $Stage) { Remove-Item -Recurse -Force -LiteralPath $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item -LiteralPath $Executable -Destination (Join-Path $Stage "PMS内网应用连接助手.exe")
Copy-Item -LiteralPath (Join-Path $ProjectDir "README.md") -Destination (Join-Path $Stage "使用说明.md")

if ($FrpcArchive) {
    if (-not (Test-Path -LiteralPath $FrpcArchive)) { throw "找不到 frpc 压缩包：$FrpcArchive" }
    $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $FrpcArchive).Hash.ToUpperInvariant()
    if ($ActualHash -ne $ExpectedFrpcHash) { throw "frpc 压缩包校验失败，拒绝打包。实际 SHA-256：$ActualHash" }
    $Expand = Join-Path $ReleaseRoot ("frpc-" + [Guid]::NewGuid().ToString("N"))
    try {
        Expand-Archive -LiteralPath $FrpcArchive -DestinationPath $Expand
        $Frpc = Get-ChildItem -Path $Expand -Filter frpc.exe -Recurse | Select-Object -First 1
        if (-not $Frpc) { throw "frpc 压缩包内没有 frpc.exe" }
        Copy-Item -LiteralPath $Frpc.FullName -Destination (Join-Path $Stage "frpc.exe")
    }
    finally { Remove-Item -Recurse -Force -LiteralPath $Expand -ErrorAction SilentlyContinue }
}

$Zip = Join-Path $ReleaseRoot ("PMS内网应用连接助手-$Version.zip")
if (Test-Path -LiteralPath $Zip) { Remove-Item -Force -LiteralPath $Zip }
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip
Write-Host "构建、自检与打包完成：$Zip" -ForegroundColor Green
if (-not $FrpcArchive) { Write-Host "当前包未包含代理核心，仅适合升级现有电脑。新电脑首次安装请传入官方 frpc 压缩包。" -ForegroundColor Yellow }
