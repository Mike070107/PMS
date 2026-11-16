param(
    [ValidateSet('auto', 'api', 'web', 'assistant')]
    [string] $Target = 'auto',
    [switch] $NoFetch
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Remote = 'ubuntu@124.223.179.214'
$Key = Join-Path $env:USERPROFILE '.ssh\pms_repair_key.pem'
$script:ReleasePhases = [Collections.Generic.List[object]]::new()
$ReleaseStartedAt = [DateTime]::UtcNow.ToString('o')
$ReleaseWatch = [Diagnostics.Stopwatch]::StartNew()
$ReleaseSucceeded = $false

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
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $passed = $false
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 的 native stderr 是 ErrorRecord；普通 pnpm/tar 提示不等于失败。
        # 仍立即抛出真正的 PowerShell 错误，原生命令则以退出码判定。
        $ErrorActionPreference = 'Continue'
        & $body 2>&1 | ForEach-Object {
            if ($_ -is [Management.Automation.ErrorRecord] -and $_.FullyQualifiedErrorId -notlike 'NativeCommandError*') { throw $_ }
            Write-Host $_
        }
        if ($LASTEXITCODE -ne 0) { Die ("步骤失败：" + $label) }
        $passed = $true
    }
    finally {
        $ErrorActionPreference = $previousPreference
        $watch.Stop()
        $phase = [ordered]@{label=$label; startedAt=$startedAt; elapsedMs=$watch.ElapsedMilliseconds; passed=$passed}
        $script:ReleasePhases.Add($phase)
        Write-Host ("[release-phase] " + (ConvertTo-Json $phase -Compress)) -ForegroundColor DarkGray
    }
}

function Dirty([string[]] $paths) {
    return @(GitLines (@('status', '--porcelain', '--') + $paths))
}


function Test-DependencyChanges([string] $target, [string[]] $changedFiles) {
    $tag = "refs/tags/deployed/$target"
    $base = & git.exe -C $RepoRoot rev-parse --verify --quiet $tag 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $base) { return $true }
    if (@($changedFiles | Where-Object { $_ -in @('pnpm-workspace.yaml', '.npmrc') }).Count -gt 0) { return $true }
    if (@($changedFiles | Where-Object { $_ -eq 'pnpm-lock.yaml' }).Count -gt 0) {
        if ($target -ne 'api') { return $true }
        Run '核对运行依赖检查回归' { python (Join-Path $PSScriptRoot 'api-runtime-dependencies.test.py') }
        $runtimeState = & python (Join-Path $PSScriptRoot 'api-runtime-dependencies.py') $tag
        if ($LASTEXITCODE -ne 0 -or $runtimeState -notin @('same', 'changed')) { Die '无法核对 API 运行依赖，停止发布' }
        if ($runtimeState -eq 'changed') { return $true }
        Write-Host '已核对 API 完整运行依赖（含间接依赖与完整性）未变，保留服务器现有依赖。'
    }
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

function Get-CachedPackage([string] $target, [string] $mode) {
    $cached = & node deploy/release-check.mjs package-find $target $SourceCommit $mode
    if ($LASTEXITCODE -ne 0) { Die '无法安全核对已有制品，停止发布' }
    return ($cached -join "`n").Trim()
}

function Make-WebPackage([string] $stamp) {
    $cached = Get-CachedPackage 'web' 'web'
    if ($cached) { Write-Host '复用已核对 SHA256 和内嵌身份的 Web 制品。'; return $cached }
    Run '构建或复用正式 Web' { node deploy/release-check.mjs build web $SourceCommit }
    Run '记录 Web 制品身份' { node deploy/release-check.mjs stamp web $SourceCommit }
    $dist = Join-Path $RepoRoot 'apps\neighbor-web\dist'
    if (-not (Test-Path (Join-Path $dist 'index.html'))) { Die 'Web 构建没有生成 dist/index.html' }
    $package = Join-Path $RepoRoot ("deploy\pms-web-" + $stamp + '.tar.gz')
    Run '压缩 Web 静态资源' { tar -czf $package -C $dist . }
    Run '保存 Web 制品复用证据' { node deploy/release-check.mjs package-save web $SourceCommit web $package }
    return $package
}

function Make-ApiPackage([string] $stamp, [string[]] $pending, [string[]] $changedFiles) {
    $dependencyChanged = Test-DependencyChanges 'api' $changedFiles
    $mode = if ($dependencyChanged) { 'full' } else { 'fast' }
    $cached = Get-CachedPackage 'api' $mode
    if ($cached) { Write-Host '复用已核对 SHA256 和内嵌身份的 API 制品。'; return $cached }

    if ($dependencyChanged) {
        Write-Host '检测到依赖文件变化，使用完整 API 包（仅此类发布才重新携带 node_modules）。' -ForegroundColor Yellow
        Run '完整构建 API 包' { & (Join-Path $RepoRoot 'deploy\pack.ps1') -Only api -SourceCommit $SourceCommit }
        $package = (Get-ChildItem (Join-Path $RepoRoot 'deploy\pms-api-*.tar.gz') |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        Run '保存完整 API 制品复用证据' { node deploy/release-check.mjs package-save api $SourceCommit full $package }
        return $package
    }

    Run '构建或复用 API dist' { node deploy/release-check.mjs build api $SourceCommit }
    Run '记录 API 制品身份' { node deploy/release-check.mjs stamp api $SourceCommit }
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
        Run '保存快速 API 制品复用证据' { node deploy/release-check.mjs package-save api $SourceCommit fast $package }
        return $package
    }
    finally {
        $expectedStage = [IO.Path]::GetFullPath((Join-Path $RepoRoot ("deploy\.quick-api-" + $stamp)))
        if ([IO.Path]::GetFullPath($stage) -ne $expectedStage -or $stamp -notmatch '^\d{8}-\d{6}$') { Die '临时目录身份异常，拒绝清理' }
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
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
$releaseLock = $null
$previousBuildCommit = $env:VITE_BUILD_COMMIT
$previousApiBase = $env:VITE_API_BASE_URL
$previousWebBase = $env:VITE_BASE
$previousWebVersion = $env:VITE_APP_VERSION
$previousCI = $env:CI
try {
    $gitDirectory = Git @('rev-parse', '--path-format=absolute', '--git-common-dir')
    try { $releaseLock = [IO.File]::Open((Join-Path $gitDirectory 'pms-production.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { Die '另一个任务正在发布生产，本次不重复执行。' }
    if (-not (Test-Path -LiteralPath $Key)) { Die "找不到 SSH 密钥：$Key" }
    if ($NoFetch) {
        Write-Host '==> 跳过远端标签同步（使用本地部署标记）' -ForegroundColor Yellow
    } else {
        Write-Host '==> 同步远端部署标记' -ForegroundColor Cyan
        Run '同步远端 main 与部署标记' { Git @('fetch', '-q', 'origin', '--tags', '--force') | Out-Null }
    }

    $SourceCommit = Git @('rev-parse', 'HEAD')
    $env:VITE_BUILD_COMMIT = $SourceCommit
    $env:CI = 'true'
    $env:VITE_API_BASE_URL = '/api/v1'
    $env:VITE_BASE = '/'
    # 同一冻结提交的门禁构建/打包/失败重试使用相同编译输入，不因墙钟分钟变化重编。
    $commitTime = [DateTimeOffset]::Parse((Git @('show', '-s', '--format=%cI', $SourceCommit)))
    $env:VITE_APP_VERSION = "2.0.$($commitTime.ToString('yyyyMMdd-HHmm'))"
    Run '发布检查自测' { node --test deploy/release-check.test.mjs deploy/neighbor-production.test.mjs deploy/release-cache.test.mjs }
    $targets = if ($Target -eq 'auto') { @('api', 'web', 'assistant') } else { @($Target) }
    $definitions = (& node deploy/release-check.mjs definitions) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { Die '无法读取发布目标定义' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    foreach ($targetName in $targets) {
        $paths = [string[]]$definitions.$targetName.paths
        $dirty = Dirty $paths
        if ($dirty.Count -gt 0) {
            Die ("$targetName 相关路径有未提交改动，已停止，避免把半成品带入生产：`n" + ($dirty -join "`n"))
        }
        $changedFiles = @(& node deploy/release-check.mjs changed $targetName $SourceCommit | Where-Object { $_ })
        if ($LASTEXITCODE -ne 0) { Die '无法读取目标差异' }
        if ($changedFiles.Count -eq 0) {
            Write-Host "✓ $targetName 没有运行源码差异，跳过构建和上传。" -ForegroundColor Green
            continue
        }
        Run "$targetName 源码与相关回归" { node deploy/release-check.mjs check $targetName $SourceCommit }
        if ($targetName -eq 'assistant') {
            Run '发布数据同步助手' { & (Join-Path $RepoRoot 'tools/data-sync-assistant-v2/publish-update.ps1') -Upload -SourceCommit $SourceCommit }
            Run '标记助手已发布（不代表现场已安装）' { node deploy/mark-deployed.mjs assistant --commit $SourceCommit }
            continue
        }

        Write-Host ("`n==> 发布 $targetName，源码 " + $SourceCommit.Substring(0, 7)) -ForegroundColor Magenta
        $package = if ($targetName -eq 'web') {
            Make-WebPackage $stamp
        } else {
            Make-ApiPackage $stamp @() $changedFiles
        }
        $packageName = Split-Path -Leaf $package
        $remotePackage = "/tmp/$packageName"
        Run '上传前确认源码未变' { node deploy/release-check.mjs verify-source $targetName $SourceCommit }
        Run "上传 $packageName" { scp -q -i $Key $package ("$Remote`:$remotePackage") }
        $remoteScript = Join-Path $RepoRoot ("deploy\srv-deploy-$targetName.sh")
        Run "上传部署脚本 $targetName" { scp -q -i $Key $remoteScript ("$Remote`:/tmp/srv-deploy-$targetName.sh") }
        Run "服务器部署 $targetName" { ssh -q -i $Key $Remote "bash /tmp/srv-deploy-$targetName.sh '$remotePackage'" }
        Run '核对公网运行版本和制品' { node deploy/release-check.mjs verify-live $targetName }
        Run "记录 $targetName 已上线" { node (Join-Path $RepoRoot 'deploy\mark-deployed.mjs') $targetName '--pkg' $packageName '--commit' $SourceCommit }
        Prune-LocalPackages
        Write-Host "✓ $targetName 已发布：$packageName" -ForegroundColor Green
    }

    $ReleaseSucceeded = $true
    Write-Host "`n完成。之后的 API 纯代码发布只上传快速包，不再重复上传 node_modules。" -ForegroundColor Green
}
finally {
    $ReleaseWatch.Stop()
    try {
        $timingDir = Join-Path $RepoRoot 'artifacts\release-checks'
        New-Item -ItemType Directory -Force -Path $timingDir | Out-Null
        $timingFile = Join-Path $timingDir ("publish-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$PID-timings.json")
        [ordered]@{startedAt=$ReleaseStartedAt; elapsedMs=$ReleaseWatch.ElapsedMilliseconds; passed=$ReleaseSucceeded; commit=$SourceCommit; target=$Target; phases=@($script:ReleasePhases.ToArray())} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $timingFile -Encoding UTF8
        Write-Host ("发布总耗时：{0:N1} 秒；计时证据：{1}" -f ($ReleaseWatch.ElapsedMilliseconds/1000), $timingFile)
    } catch { Write-Warning ("无法保存发布计时：" + $_.Exception.Message) }
    if ($releaseLock) { $releaseLock.Dispose() }
    $env:VITE_BUILD_COMMIT = $previousBuildCommit
    $env:VITE_API_BASE_URL = $previousApiBase
    $env:VITE_BASE = $previousWebBase
    $env:VITE_APP_VERSION = $previousWebVersion
    $env:CI = $previousCI
    Pop-Location
}
