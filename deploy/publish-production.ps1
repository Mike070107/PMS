param(
    [ValidateSet('auto', 'api', 'web')]
    [string] $Target = 'auto',
    [switch] $NoFetch
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Remote = 'ubuntu@124.223.179.214'
$Key = Join-Path $env:USERPROFILE '.ssh\pms_repair_key.pem'

function Die([string] $message) {
    throw $message
}

function Git([string[]] $gitArgs) {
    $result = & git.exe -C $RepoRoot @gitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    return ($result -join "`n").Trim()
}

function GitLines([string[]] $gitArgs) {
    $result = & git.exe -C $RepoRoot @gitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    return @($result | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
}

function Run([string] $label, [scriptblock] $body) {
    Write-Host ("==> " + $label) -ForegroundColor Cyan
    # 子命令输出直接写到主机，不能回流到函数返回值；否则 Make-WebPackage 的
    # 构建日志会和 tar 路径一起被 scp 当成多个参数，触发 ambiguous target。
    & $body | Out-Host
    if ($LASTEXITCODE -ne 0) { Die ("步骤失败：" + $label) }
}

function Dirty([string[]] $paths) {
    return @(GitLines (@('status', '--porcelain', '--') + $paths))
}

function Pending([string] $target, [string[]] $paths) {
    $tag = "refs/tags/deployed/$target"
    $base = & git.exe -C $RepoRoot rev-parse --verify --quiet $tag 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $base) { return @() }
    return @(GitLines (@('log', '--oneline', "$tag..HEAD", '--') + $paths))
}

function ChangedFiles([string] $target, [string[]] $paths) {
    $tag = "refs/tags/deployed/$target"
    $base = & git.exe -C $RepoRoot rev-parse --verify --quiet $tag 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $base) { return @() }
    return @(GitLines (@('diff', '--name-only', "$tag..HEAD", '--') + $paths))
}

function Test-DependencyChanges([string] $target, [string[]] $changedFiles) {
    if (@($changedFiles | Where-Object { $_ -eq 'pnpm-lock.yaml' }).Count -gt 0) { return $true }
    $tag = "refs/tags/deployed/$target"
    $base = & git.exe -C $RepoRoot rev-parse --verify --quiet $tag 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $base) { return $false }
    $dependencyFields = @('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'engines', 'packageManager')
    foreach ($path in @($changedFiles | Where-Object { $_ -match '(^|/)package\.json$' })) {
        $before = (Git @('show', ($tag + ':' + $path))) | ConvertFrom-Json
        $after = (Get-Content -LiteralPath (Join-Path $RepoRoot ($path -replace '/', '\')) -Raw) | ConvertFrom-Json
        foreach ($field in $dependencyFields) {
            $beforeValue = ConvertTo-Json $before.$field -Depth 30 -Compress
            $afterValue = ConvertTo-Json $after.$field -Depth 30 -Compress
            if ($beforeValue -ne $afterValue) { return $true }
        }
    }
    return $false
}

function Make-WebPackage([string] $stamp) {
    Run '构建管理后台' { pnpm --filter '@pms/admin-web' build }
    $dist = Join-Path $RepoRoot 'apps\admin-web\dist'
    if (-not (Test-Path (Join-Path $dist 'index.html'))) { Die 'Web 构建没有生成 dist/index.html' }
    $package = Join-Path $RepoRoot ("deploy\pms-web-" + $stamp + '.tar.gz')
    Run '压缩 Web 静态资源' { tar -czf $package -C $dist . }
    return $package
}

function Make-ApiPackage([string] $stamp, [string[]] $pending, [string[]] $changedFiles) {
    $dependencyChanged = Test-DependencyChanges 'api' $changedFiles

    if ($dependencyChanged) {
        Write-Host '检测到依赖文件变化，使用完整 API 包（仅此类发布才重新携带 node_modules）。' -ForegroundColor Yellow
        Run '完整构建 API 包' { & (Join-Path $RepoRoot 'deploy\pack.ps1') -Only api }
        return (Get-ChildItem (Join-Path $RepoRoot 'deploy\pms-api-*.tar.gz') |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    }

    Run '构建 API dist' { pnpm --filter '@pms/api' build }
    $stage = Join-Path $RepoRoot ("deploy\.quick-api-" + $stamp)
    $apiStage = Join-Path $stage 'api'
    New-Item -ItemType Directory -Force -Path $apiStage | Out-Null
    try {
        Copy-Item -Recurse -Force (Join-Path $RepoRoot 'apps\api\dist') (Join-Path $apiStage 'dist')
        Copy-Item -Force (Join-Path $RepoRoot 'apps\api\package.json') (Join-Path $apiStage 'package.json')
        Copy-Item -Force (Join-Path $RepoRoot 'apps\api\ecosystem.config.cjs') (Join-Path $apiStage 'ecosystem.config.cjs')
        Set-Content -LiteralPath (Join-Path $apiStage '.pms-fast-release') -Value 'dist-only-v1' -NoNewline
        $package = Join-Path $RepoRoot ("deploy\pms-api-fast-" + $stamp + '.tar.gz')
        Run '压缩 API 快速包' { tar -czf $package -C $stage api }
        return $package
    }
    finally {
        if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    }
}

function Prune-LocalPackages([int] $keep = 3) {
    foreach ($prefix in @('pms-api-', 'pms-web-')) {
        $packages = @(Get-ChildItem (Join-Path $RepoRoot 'deploy') -File -Filter ($prefix + '*.tar.gz') |
            Sort-Object LastWriteTime -Descending)
        if ($packages.Count -le $keep) { continue }
        foreach ($old in ($packages | Select-Object -Skip $keep)) {
            Remove-Item -LiteralPath $old.FullName -Force
            Write-Host ("清理本地旧包：" + $old.Name) -ForegroundColor DarkGray
        }
    }
}

Push-Location $RepoRoot
try {
    if (-not (Test-Path -LiteralPath $Key)) { Die "找不到 SSH 密钥：$Key" }
    if ($NoFetch) {
        Write-Host '==> 跳过远端标签同步（使用本地部署标记）' -ForegroundColor Yellow
    } else {
        Write-Host '==> 同步远端部署标记' -ForegroundColor Cyan
        Git @('fetch', '-q', 'origin', '--tags', '--force') | Out-Null
    }

    $targets = if ($Target -eq 'auto') { @('api', 'web') } else { @($Target) }
    $definitions = @{
        api = @('apps/api', 'packages/shared-types', 'pnpm-lock.yaml', 'deploy/srv-deploy-api.sh')
        web = @('apps/admin-web', 'packages/shared-types', 'packages/api-client', 'pnpm-lock.yaml')
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    foreach ($targetName in $targets) {
        $paths = [string[]]$definitions[$targetName]
        $dirty = Dirty $paths
        if ($dirty.Count -gt 0) {
            Die ("$targetName 相关路径有未提交改动，已停止，避免把半成品带入生产：`n" + ($dirty -join "`n"))
        }
        $pending = Pending $targetName $paths
        if ($pending.Count -eq 0) {
            Write-Host "✓ $targetName 没有待发布提交，跳过构建和上传。" -ForegroundColor Green
            continue
        }
        $changedFiles = ChangedFiles $targetName $paths

        Write-Host ("`n==> 发布 $targetName（待发布 " + $pending.Count + " 个提交）") -ForegroundColor Magenta
        $package = if ($targetName -eq 'web') {
            Make-WebPackage $stamp
        } else {
            Make-ApiPackage $stamp $pending $changedFiles
        }
        $packageName = Split-Path -Leaf $package
        $remotePackage = "/tmp/$packageName"
        Run "上传 $packageName" { scp -q -i $Key $package ("$Remote`:$remotePackage") }
        $remoteScript = Join-Path $RepoRoot ("deploy\srv-deploy-$targetName.sh")
        Run "上传部署脚本 $targetName" { scp -q -i $Key $remoteScript ("$Remote`:/tmp/srv-deploy-$targetName.sh") }
        Run "服务器部署 $targetName" { ssh -q -i $Key $Remote "bash /tmp/srv-deploy-$targetName.sh '$remotePackage'" }
        Run "记录 $targetName 已上线" { node (Join-Path $RepoRoot 'deploy\mark-deployed.mjs') $targetName '--pkg' $packageName }
        Prune-LocalPackages
        Write-Host "✓ $targetName 已发布：$packageName" -ForegroundColor Green
    }

    Write-Host "`n完成。之后的 API 纯代码发布只上传快速包，不再重复上传 node_modules。" -ForegroundColor Green
}
finally {
    Pop-Location
}
