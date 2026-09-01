---
description: 收尾：校验 → 提交（明确路径）→ 推送 → 提示待部署目标
---

收尾流程，**每一步失败就停下报错，不要跳过**：

1. `git status --short`，列出本次改动涉及哪些包；
   如果出现不属于本次任务的文件，**停下来问我**，不要提交。
2. 按涉及的包跑校验（只跑相关的）：
   - `apps/admin-web` → `pnpm web:typecheck` 且 `pnpm web:build`
   - `apps/api` → `pnpm api:build`
   - `apps/miniapp-owner` → `pnpm miniapp:owner:typecheck`
   - `apps/miniapp-staff` → `pnpm miniapp:staff:typecheck`
3. `git add <明确路径>`（禁止 `git add -A`），`git diff --cached --stat` 给我看一眼。
4. 提交，说明「为什么改」而不是「改了什么」。
5. `git push`。
6. `node deploy/mark-deployed.mjs status`，明确告诉我：
   **哪些目标需要部署 / 上传小程序包**，以及部署完要跑的 `mark-deployed` 命令。
   （部署本身等我确认，不要自己发。）
7. 如果本次修的是 `docs/bug-inbox.md` 里的条目，把对应行改成 `[x]` 并移到「已修复」，附提交号。

补充说明：$ARGUMENTS
