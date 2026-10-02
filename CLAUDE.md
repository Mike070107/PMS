# PMS 项目工作约定（Codex / Claude Code 共用）

## 边界与完成标准

- 默认单 agent；用户明确要求数字团队才启动。任务明确直接实现、验证、交付，不因旧流程强制暂停，不在小修中重设计或新建平行实现。
- 先说清本次范围、完成条件和真正阻塞点。按正式入口 → API → 助手 → 数据保存/刷新读取 → 设备确认（适用）留证据；缺一环明确未完成。
- 预览可见、接口接受、队列成功、绿色在线分别只证明各自一层，不代表真实业务完成。
- 先复现、补回归，再修同类入口；复用已有代码和同源码有效证据。源码/依赖/环境改变后才重跑受影响检查。
- UI 按现有品牌规范，在真实浏览器检查桌面/窄屏/错误/等待/成功；先确认构建。失败保留输入，结果未知先查原任务，正式业务不自动进 mock。
- 生产必须有当次明确授权。“修复”不等于生产授权；测试环境不明确先核实。小程序默认只上传并设体验版，审核/正式发布另需授权。

## 环境与源码

- 唯一长期目录 D:\00项目开发\PMS；集成主线 main。先检查状态，只暂存本任务明确文件，不覆盖其他任务改动。并行任务才用独立临时 worktree，不共用索引。
- 唯一生产 ubuntu@124.223.179.214，私网 10.0.4.8，/opt/pms-repair/，https://prsznh.cn/；密钥 ~/.ssh/pms_repair_key.pem。旧机 1.15.172.131 已退出 PMS，禁止连接/依赖。生产操作前核对现场身份。
- 合入并推送 main 后再构建；上传前检查源码未变。不可把工作区半成品或临时改服务器当正式发布。
- 发布后分别报告 Web/API/助手版本及提交、实际测试、现场未升级、未验证项。更新包发布≠现场安装，数据库写入≠设备确认，回执≠现场刷卡验证。

## 命令与按需文档

- 工作区：git status --short；部署状态：node deploy/mark-deployed.mjs status。
- 停车核心测试：pnpm --filter @pms/api test:access-card 和 test:parking-owner；类型检查/构建只跑受影响端。
- 已授权生产入口：./deploy/publish-production.ps1 -Target auto。完成后核对公网版本、提交、哈希并标记 deployed/<target>。
- /start、/ship 只是可选快捷入口；不要求工具支持，不要求用户按 Shift+Tab、Esc 或 /clear 才继续。

| 当前工作 | 按需读取 |
|---|---|
| 分支/验证/交付 | docs/development-workflow.md |
| 生产/回退/WVP | deploy/README.md、deploy/DEPLOY_LOG.md |
| 停车字段/业务完成度/缺口 | docs/parking-management-implementation.md |
| Windows 助手/升级 | tools/data-sync-assistant-v2/README.md、SelfTest.cs |
| Web UI | design-system/pms-admin/MASTER.md |
| 小程序 UI | design-system/pms-miniapp/MASTER.md |
| 新建/重构数据列表、详情、看板 | .claude/skills/data-first-ui/SKILL.md |

全局唯一入口 C:/Users/Administrator/.codex/AGENTS.md。事故留在项目专题，优先变成自动回归，不继续堆长常驻指引。
