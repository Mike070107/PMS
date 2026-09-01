---
description: 开工检查：当前在哪个 worktree/分支、线上落后多少、收件箱有什么
---

按顺序做完，用一段话汇报，不要自作主张开始改代码：

1. `git worktree list` + `git rev-parse --abbrev-ref HEAD` + `git status --short`
   —— 说明当前在哪个目录、哪个分支、有没有别人留下的未提交改动。
2. `node deploy/mark-deployed.mjs status` —— 四个目标各自还差几个提交没上线。
3. 读 `docs/bug-inbox.md`「待处理」，列出条数和前 5 条（要按顺序做完就用 `/inbox`，不带参数）。

然后问一句：这次做哪件事。若我已经在这条消息里说了（$ARGUMENTS），直接进入 plan mode 出方案。
