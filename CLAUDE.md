# PMS 项目内工作约定

> 全局偏好见 `~/.claude/CLAUDE.md`，冲突时以本文件为准。
> 本文件解决的是「一边开发一边测出 bug、多个会话并行」时反复出现的三类事故：
> 指令被吞、改动互相覆盖、推送/部署遗漏。

## 一、唯一主目录与分支（硬性）

- **唯一长期工作目录是 `D:\00项目开发\PMS`，唯一集成主线是 `main`。**
  不要再进入 `PMS-theme-deploy`、`PMS-stocktake`、`PMS-web-stocktake` 等历史目录继续开发。
- 默认在唯一主目录中从最新 `main` 建一个短期任务分支；任务完成后合回 `main` 并删除任务分支：
  ```powershell
  Set-Location 'D:\00项目开发\PMS'
  git switch main
  git pull --ff-only
  git switch -c codex/fix-repair-time
  # 修改、测试、提交
  git switch main
  git pull --ff-only
  git merge --ff-only codex/fix-repair-time
  git push origin main
  git branch -d codex/fix-repair-time
  ```
- 只有两个任务确实需要同时执行时才创建临时 worktree，并做到“一任务一分支一会话”。
  临时 worktree 必须在任务合回 `main` 后马上删除，不得把 `*-deploy` 目录长期保留为第二主线。
- 两个会话绝不能同时指向同一个目录；那会共享 Git 索引，导致提交夹带别人的半成品。
- 开工第一件事跑 `/start`，收尾跑 `/ship`。完整流程见 `docs/development-workflow.md`。

## 二、测试中发现 bug：写进收件箱，不要打断正在跑的会话

在 Claude 执行过程中输入的消息会排队到下一个回合才送达，赶上长任务或上下文压缩时
很容易被埋掉 —— 这就是「指令被丢弃」的真正原因。所以：

- **默认动作：`/inbox <一句话>`** —— 只往 `docs/bug-inbox.md` 追加一条，不打断当前任务。
  当前任务收尾时或下一个会话开工时统一处理；`/inbox` 不带参数 = 按顺序把待处理做完。
  （原来叫 `/bug`，和 Claude Code 内置的 `/bug`（向 Anthropic 反馈）撞名，
  内置的优先，打 `/bug` 只会弹反馈框、这条根本不会进收件箱 —— 2026-09-01 实测。）
- **必须立刻改**（阻塞测试、线上炸了）：先按 **Esc 打断**，再说这个 bug。
  Esc 不会丢掉已经写进文件的改动，打断后说的话是下一条指令，一定被执行。
- **不要**边跑边打字期待它照办。要么进收件箱，要么先 Esc。

## 三、提交与推送

- 共用 checkout 时**只 `git add` 明确路径**，禁止 `git add -A` / `git add .`；
  提交前必看 `git diff --cached --stat`，确认没有别的会话的文件。
- **推送前的校验闸门（每台机器配一次，所有 worktree 共享）**：
  ```powershell
  git config core.hooksPath tools/githooks
  ```
  `tools/githooks/pre-push` 按本次推送改了哪块决定跑哪几项（共享包构建 / 各端 typecheck），
  不过就拒绝推送。它挡的是 2026-09-01 那类事故：一个会话把编译不过的东西推进 main，
  十几分钟后另一个会话打包才撞上，谁都发不了小程序包。
  紧急情况用 `git push --no-verify` 跳过，自己负责。
- 推送 ≠ 上线。三个目标各自独立：git / 线上 API+后台 / 小程序包。
  部署完必须 `node deploy/mark-deployed.mjs <目标>` 打标记，
  推送前先 `node deploy/mark-deployed.mjs status` 看哪些提交还没上线。
- 打包一律从已经合并并保持干净的 `D:\00项目开发\PMS` 主目录执行。
  如主目录正在进行未完成任务，先完成或暂停并恢复干净状态，不得换到历史 `*-deploy` 目录发布旧代码。

## 四、上下文纪律

- 换一件不相干的事 → 先 `/clear`。带着上一个任务的上下文做新功能，
  最容易改到不该改的文件。
- 超过 3 步、要动多个包的改动 → 先 Shift+Tab 进 plan mode，
  确认计划再执行；执行期间不要插话。
