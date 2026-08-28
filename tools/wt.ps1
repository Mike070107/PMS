<#
  并行开发用的 worktree 助手。
  为什么要有它：两个 Claude 会话开在同一个目录会共用 git 索引和工作区，
  A 的 git add 会把 B 的半成品一起提交推走。一个任务一个 worktree 就没有这个问题。

    powershell -File tools/wt.ps1 new  fix-repair-time   # 建 ../PMS-fix-repair-time，分支 feat/fix-repair-time
    powershell -File tools/wt.ps1 list                   # 每个 worktree 在哪个分支、有没有未提交改动
    powershell -File tools/wt.ps1 done fix-repair-time   # 合回 main 之后清掉 worktree 和分支

  注意：本文件必须存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读，中文乱码且解析报错。
#>
param(
  [Parameter(Position = 0)][ValidateSet('new', 'list', 'done')][string]$Action = 'list',
  [Parameter(Position = 1)][string]$Name
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $root

function Get-Dir([string]$n) { Join-Path $parent "PMS-$n" }
function Get-Branch([string]$n) { "feat/$n" }

# git 默认会把非 ASCII 路径转义成八进制，加 core.quotePath=false 才拿得到能用的路径
function Get-Worktrees {
  $out = git -C $root -c core.quotePath=false worktree list --porcelain
  $result = @()
  $cur = $null
  foreach ($line in $out) {
    if ($line -like 'worktree *') {
      $cur = [pscustomobject]@{ Path = $line.Substring(9); Branch = '(detached)' }
      $result += $cur
    } elseif ($line -like 'branch *' -and $cur) {
      $cur.Branch = $line.Substring(7) -replace '^refs/heads/', ''
    }
  }
  return $result
}

switch ($Action) {
  'new' {
    if (-not $Name) { throw '用法: powershell -File tools/wt.ps1 new <任务名>（英文短横线，如 fix-repair-time）' }
    $dir = Get-Dir $Name
    $branch = Get-Branch $Name
    if (Test-Path $dir) { throw "$dir 已存在，换个名字，或先 done 掉" }
    $exists = git -C $root rev-parse --verify --quiet "refs/heads/$branch"
    if ($exists) {
      git -C $root worktree add $dir $branch
    } else {
      git -C $root fetch origin main --quiet
      if ($LASTEXITCODE -ne 0) { Write-Output '（fetch 没成功，用本地已有的 origin/main 建分支，注意可能不是最新的）' }
      git -C $root worktree add -b $branch $dir origin/main
    }
    if ($LASTEXITCODE -ne 0) { throw 'worktree 创建失败' }
    Write-Output ''
    Write-Output "已创建: $dir   分支 $branch（基于 origin/main）"
    Write-Output '下一步: VSCode 另开一个窗口打开这个目录，在那里开新的 Claude 会话。'
    Write-Output "        code `"$dir`""
    Write-Output '注意: node_modules 不共享，第一次要在新目录跑 pnpm install。'
  }
  'list' {
    foreach ($wt in Get-Worktrees) {
      $dirty = @(git -C $wt.Path status --porcelain)
      if ($dirty.Count -gt 0) { $mark = "有未提交改动 $($dirty.Count) 个文件" } else { $mark = '干净' }
      Write-Output ("{0,-46} {1,-28} [{2}]" -f $wt.Path, $wt.Branch, $mark)
    }
  }
  'done' {
    if (-not $Name) { throw '用法: powershell -File tools/wt.ps1 done <任务名>' }
    $dir = Get-Dir $Name
    $branch = Get-Branch $Name
    if (-not (Test-Path $dir)) { throw "$dir 不存在" }
    $dirty = @(git -C $dir status --porcelain)
    if ($dirty.Count -gt 0) { throw "$dir 还有未提交改动，先提交或丢弃再 done：`n$($dirty -join "`n")" }
    $unmerged = @(git -C $root log --oneline "origin/main..$branch")
    if ($unmerged.Count -gt 0) { throw "$branch 还有没合进 origin/main 的提交，先合并推送：`n$($unmerged -join "`n")" }
    git -C $root worktree remove $dir
    git -C $root branch -d $branch
    Write-Output "已清理 $dir 和分支 $branch"
  }
}
