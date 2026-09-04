# PMS 开发主线、分支与部署约定

本文是 PMS 后续修改的唯一流程说明，解决“多个目录看起来都是项目，不知道该改哪一份”的问题。

## 1. 唯一事实来源

| 项目 | 唯一入口 |
|---|---|
| 本机长期工作目录 | `D:\00项目开发\PMS` |
| 集成分支 | `main` |
| 远端事实来源 | `origin/main` |
| 生产 API 版本 | `deployed/api` 标签 |
| 生产 Web 版本 | `deployed/web` 标签 |
| 员工小程序上传版本 | `deployed/miniapp-staff` 标签 |
| 业主小程序上传版本 | `deployed/miniapp-owner` 标签 |

`PMS-theme-deploy`、`PMS-stocktake`、`PMS-web-stocktake`、`PMS-deploy` 等名称带后缀的目录，
过去是并行任务生成的 worktree。它们不是独立项目，也不是新的主线。后续不要在这些目录继续修改。

## 2. 2026-09-03 合并结论

本次逐个检查了所有工作树和分支：

- `codex/theme-deploy`
- `codex/web-stocktake`
- `codex/split-my-repairs-permission`
- `feat/stocktake`
- 历史 detached 部署工作树

这些分支中所有已经提交的代码都是 `origin/main` 的祖先，说明提交层面的功能已经全部进入主线，
不需要再重复 merge 或 cherry-pick。

两个旧目录里发现了未提交草稿。为防止误删，已分别保存并推送到远端归档分支：

- `codex/archive-pms-draft-20260903`：旧 `PMS` 目录中的反馈闭环、界面等混合草稿。
- `codex/archive-stocktake-draft-20260903`：早期库存盘点实现草稿。

归档分支只是防丢备份，基线较旧且部分实现已经被主线的新版本替代，**禁止整分支直接合并到 main**。
以后若确认其中某项仍有价值，只按功能逐文件核对后重新实现或挑选必要提交。

## 3. 日常修改流程

### 开始任务

```powershell
Set-Location 'D:\00项目开发\PMS'
git switch main
git pull --ff-only
git status --short
git switch -c codex/<简短任务名>
```

`git status --short` 必须为空。如果出现不属于当前任务的修改，先查清来源，不要覆盖、还原或顺手提交。

### 完成任务

1. 运行与改动范围相称的测试、类型检查和构建。
2. 只暂存本任务明确修改的文件，检查 `git diff --cached --stat` 后提交。
3. 在同一个目录切回 `main`，快进远端并合并任务分支。

```powershell
git switch main
git pull --ff-only
git merge --ff-only codex/<简短任务名>
git push origin main
git branch -d codex/<简短任务名>
```

如果 `--ff-only` 失败，说明主线在任务期间前进了。切回任务分支 rebase 到最新 `origin/main`，
解决冲突并重新验证后再合并，不要创建含义不明的大型合并提交。

## 4. 什么时候允许 worktree

只有两个互不依赖的任务确实需要同时推进时才使用临时 worktree：

```powershell
pwsh tools/wt.ps1 new <任务名>
pwsh tools/wt.ps1 list
```

规则：

- 一个 worktree 只对应一个任务分支和一个会话。
- 发布前先把任务合入 `main`，不能直接从临时目录发布。
- 合入后立即执行 `pwsh tools/wt.ps1 done <任务名>`，不保留长期副本。
- 部署、盘点、主题等任务名不能变成永久目录或永久主线。

## 4.5 发版前的功能冒烟（真登录，不是 mock）

`typecheck` / `build` / 单测**证明不了功能是好的**：它们不会点开一个抽屉、不会发现按钮被挤出视口、
也不会告诉你接口回来的数据在界面上压根没渲染。2026-09-04 的反馈是「你修改后是不是没对功能做测试」——
在那之前几轮 UI 改动都只用本地 mock 预览包看过，没真登录过系统。

**改了后台（`apps/admin-web`）或它依赖的接口，推送前跑一遍：**

```bash
# 账号密码放本机 .smoke-credentials（两行：账号、密码），已在 .gitignore 里，绝不入库
node <browser-automation skill 目录>/browser.mjs https://prsznh.cn/login --script tools/web-smoke.mjs
```

输出 `failed > 0` 就是有回归，先修再发。新增功能就往 `tools/web-smoke.mjs` 里补一个 case，
它是这个项目目前**唯一**能证明「界面上真的能用」的东西。

两条约束：

- 脚本只做**只读**操作（登录、翻页、点开抽屉和弹窗），不提交表单、不改数据 —— 它跑的是生产环境，
  测试数据一旦落库就得再花力气清理。
- 小程序走开发者工具的 MCP（`.mcp.json` 里的 `wechat-devtools`，49 个工具：`simulator_open_page`、
  `simulator_screenshot`、`automation_*`、`compile_wxml`、`upload`…）。它连不上时**先修它，别绕过去**：
  - 启动器是 `tools/wechatide.cmd`，只负责找到 `Program Files (x86)\Tencent\微信web开发者工具\wechatide.cmd`
    并转发，**文件必须纯 ASCII**（cmd 按 cp936 解析，UTF-8 中文会把行切碎，`chcp 65001` 也救不了）；
  - 报 `Failed to connect to WechatIDE … rediscovering port` = IDE 服务端口没开，
    跑 `tools\wechatide.cmd auth -c ClaudeCode`，回 `{"authorized":true,"port":…}` 就好了
    （`mcp` 模式下启动器已自动先做这一步）；
  - 开发者工具升级后（2026-09-03 升到 2.02 曾把旧启动器依赖的 node.exe 删掉）先用一个 node 脚本
    spawn `cmd /c tools\wechatide.cmd mcp`、写 initialize + tools/list 探一下，正常回 49 个 tools；
  - 改完 `.mcp.json` 或启动器，当前会话要在 `/mcp` 里重连才拿得到工具。
  真机预览仍以体验版为准；模拟器截图能证明布局和文案，证明不了真机手势和字体加载。

## 5. 部署流程

部署只从干净且最新的 `main` 执行：

```powershell
Set-Location 'D:\00项目开发\PMS'
git switch main
git pull --ff-only
git status --short
node deploy/mark-deployed.mjs status
```

- API / Web：按 `deploy/README.md` 构建、上传、健康检查，再运行 `mark-deployed`。
- 员工小程序：`pnpm mp:staff -- --upload --desc "说明"`。
- 业主小程序：`pnpm mp -- --upload --desc "说明"`。
- 小程序上传后还要在微信公众平台选为体验版；上传不等于用户已经运行新版本。

发布完成后再次运行：

```powershell
node deploy/mark-deployed.mjs status
```

只有目标显示“已是最新”，并且线上健康检查通过，才算部署完成。

## 6. 看到多个 PMS 目录时怎么判断

先执行：

```powershell
git worktree list
```

日常只进入 `D:\00项目开发\PMS`。其它目录若重新出现，应先确认其分支已经合回 `main`、工作区为空，
然后删除对应 worktree；不要凭文件夹修改时间判断哪份代码更新。
