param([ValidateSet("all","api","web")] [string] $Only = "all")

# don't set ErrorActionPreference Stop -- pwsh 5.1 turns pnpm stderr into ErrorRecord
# we check $LASTEXITCODE explicitly.

# tell pnpm we're non-interactive so it skips "confirm purge" prompts that abort under no-TTY
$env:CI = "true"

function Die([string] $msg) {
    Write-Host ("x  " + $msg) -ForegroundColor Red
    exit 1
}

function Run([string] $name, [scriptblock] $body) {
    Write-Host ("==> " + $name) -ForegroundColor Cyan
    & $body
    if ($LASTEXITCODE -ne 0) { Die ("step failed: " + $name + " (exit=" + $LASTEXITCODE + ")") }
}

function Remove-Tree([string] $path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    for ($i = 1; $i -le 3; $i++) {
        try {
            Remove-Item -Recurse -Force -LiteralPath $path -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $path)) { return }
        } catch {
            Start-Sleep -Milliseconds 800
        }
    }
    cmd /c ("rmdir /s /q " + ('"' + $path + '"')) 2>&1 | Out-Null
    if (Test-Path -LiteralPath $path) { Die ("cannot delete " + $path + " (locked)") }
}

function Need([string] $path, [string] $hint) {
    if (-not (Test-Path -LiteralPath $path)) { Die ("missing after " + $hint + ": " + $path) }
}

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DeployDir = Join-Path $RepoRoot "deploy"
$Ts        = Get-Date -Format "yyyyMMdd-HHmm"

Push-Location $RepoRoot
try {
    Run "pnpm install" { pnpm install }

    if ($Only -eq "all" -or $Only -eq "web") {
        Run "build admin-web" { pnpm --filter "@pms/admin-web" build }
    }

    if ($Only -eq "all" -or $Only -eq "api") {
        Run "build api" { pnpm --filter "@pms/api" build }

        $ApiDist = Join-Path $DeployDir "dist\api"
        Write-Host ("==> clean " + $ApiDist) -ForegroundColor Cyan
        Remove-Tree $ApiDist

        Run ("pnpm deploy api -> " + $ApiDist) {
            pnpm --filter "@pms/api" deploy --legacy --prod $ApiDist
        }

        Need (Join-Path $ApiDist "package.json")  "pnpm deploy"
        Need (Join-Path $ApiDist "dist\main.js") "pnpm deploy (built code)"
        Need (Join-Path $ApiDist "node_modules") "pnpm deploy (prod deps)"

        Copy-Item -Force -LiteralPath (Join-Path $RepoRoot "apps\api\ecosystem.config.cjs") `
                       -Destination   (Join-Path $ApiDist "ecosystem.config.cjs")

        $envInPkg = Join-Path $ApiDist ".env"
        if (Test-Path -LiteralPath $envInPkg) { Remove-Item -Force -LiteralPath $envInPkg }

        $ApiTar = Join-Path $DeployDir ("pms-api-" + $Ts + ".tar.gz")
        Run ("tar -> pms-api-" + $Ts + ".tar.gz") {
            tar -czf $ApiTar -C (Join-Path $DeployDir "dist") api
        }
        $size = (Get-Item -LiteralPath $ApiTar).Length
        if ($size -lt 5MB) { Die ("pms-api tarball too small: " + $size + " bytes") }
        Write-Host ("    api package: " + $ApiTar + "  (" + [math]::Round($size/1MB,2) + " MB)") -ForegroundColor Green
    }

    if ($Only -eq "all" -or $Only -eq "web") {
        $WebDist = Join-Path $RepoRoot "apps\admin-web\dist"
        Need (Join-Path $WebDist "index.html") "vite build"

        $WebTar = Join-Path $DeployDir ("pms-web-" + $Ts + ".tar.gz")
        Run ("tar -> pms-web-" + $Ts + ".tar.gz") {
            $dot = "."
            tar -czf $WebTar -C $WebDist $dot
        }
        $size = (Get-Item -LiteralPath $WebTar).Length
        if ($size -lt 50KB) { Die ("pms-web tarball too small: " + $size + " bytes") }
        Write-Host ("    web package: " + $WebTar + "  (" + [math]::Round($size/1KB,2) + " KB)") -ForegroundColor Green
    }

    # pnpm deploy --prod 会把工作区的 devDependencies 一并剪掉（tsc / 开发者工具依赖全没了），
    # 打完包必须装回来，否则下一条 typecheck、pnpm mp:staff 全部报「找不到 tsc」。
    Run "restore dev deps" { pnpm install }

    Write-Host ""
    Write-Host "==> done. next:" -ForegroundColor Yellow
    Write-Host ("    scp deploy\pms-*-" + $Ts + ".tar.gz pms:/tmp/")
    Write-Host  "    ssh pms   # follow deploy/README.md"
}
finally {
    Pop-Location
}
