# 员工工单用料草稿与库存预留

维修工选择或修改用料时保存工单草稿，并在同一事务中预留可用库存；草稿和每行备注可在重新打开工单时读取。预留不产生出库流水、不改变实际库存或批次成本。其他出库入口必须扣除预留量；不足部分按缺料处理。删除用料后释放对应预留。作废、撤单或永久删除前必须先删除锁定用料。

完工或提交缺料时，服务端核对提交内容与保存的预留一致，在事务内释放本单预留并按原 FIFO 逻辑正式出库；失败时一起回滚。已有领用仍按原退库流程处理。多人同时修改同一工单时版本不一致会拒绝覆盖。

回归命令：

```powershell
pnpm --filter @pms/api exec node -r ts-node/register --test src/modules/repairs/material-draft.http.test.ts src/modules/repairs/material-draft.test.ts src/modules/repairs/material-draft.persistence.test.ts src/modules/inventory/stock-ledger.test.ts src/modules/inventory/reservation-policy.test.ts ../../packages/shared-types/src/work-order-sort.test.ts
pnpm --filter @pms/miniapp-staff exec tsc --noEmit
```

上线前须在隔离的 PostgreSQL 环境补测真实并发竞争、完工与撤回、撤单和跨设备冲突，并核对生产表结构创建方式；模拟器布局和 PGlite 单连接测试不代替真实并发或手机现场验收。

2026-11-11 验证记录：HTTP 权限/DTO、PGlite 保存重读和事务回滚、共享排序和库存账本测试通过；员工端类型检查与 API 构建通过。模拟器使用合成数据验证按钮不溢出及申购原因显隐。图片按用户要求恢复原尺寸，语音按钮独占下一行。

本地独立 PostgreSQL 并发测试已提供 `material-draft.postgres.test.ts`，尚未执行成功：Windows 管理员启动 PostgreSQL 被数据库明确拒绝，已停止，未创建系统账号或绕过。没有部署本轮 API、没有上传本轮体验版。生产 AI 发布仍按用户约定等待报表会话先发布。

2026-11-11 续接：已与主线 Web `repair_time_desc` 排序合并兼容，新增员工 `newest` 排序在服务端截断前及返回阶段均保持一致，已完成使用 `completedAt`。27 项相关测试通过，API 构建、两端小程序 pre-push 类型检查通过。源提交 `baaeceec` 已推送 main；微信 CLI 无警告构建并成功上传员工开发版本 `1.0.20261111b`，1,097,076 字节，备注带 `baaeceec`。这是上传证据，尚未设体验版。公众平台重新访问显示登录超时；已打开登录页。库存锁定生产 API 仍待本次单独授权（此前用户明确要求等报表先发布），未移动任何 deployed 标签。

## 2026-11-11 12:48：最新主线 API 与员工体验版发布核验

- 用户本次明确授权「发布最新主线 API，再切换体验版」，允许一并发布此前等待报表的主线 API。冻结已推送主线 `1e953e2a7d3e94b672456d497dc348e9770c61fd`，包含其他会话的库存筛选与报表代码；后续主线变动核对为文档与发布记录，没有覆盖其他会话源码。API 发布入口为 `deploy/publish-production.ps1 -Target api`，未发布 Web 或助手。
- 当前生产仍为 DNS `prsznh.cn → 124.223.179.214`、实例 `VM-4-8-ubuntu`、目录 `/opt/pms-repair/`、PM2 `pms-api`。公网健康与制品核验均确认 `api-1e953e2`、上述完整提交，源码哈希 `da7e7c5b36d187794c1bbe9dd71773daf4264e234fa81cd9d7eb2aab712567ac`，构建时间 `2026-11-11T04:40:44.269Z`。生产 `.env` 发布前后 SHA-256 均为 `c8fe9decb8ff651f6b2f380605d4059cff07a031e0758117903d377dadc129b9`，未替换配置、连接身份、自动任务开关或私有附件。
- 保留原 API 制品 `/opt/pms-backups/api/pre-material-api-475b21f-20261111.tar.gz`（SHA-256 `061020b76e1706deb63c00f97c83c07e754a6c23425178b896c41d24f54a391c`）。发布前业务表一致性只读逻辑快照 `/opt/pms-backups/api/pre-material-20261111043743/database-snapshot.jsonl.gz`，19,614,073 字节，SHA-256 `4bd30e1734e188ad6a2d1d83618c2ac3a914719fcadc9ffb5a5d013938df5c6e`，`gzip -t` 通过；目录内配置副本权限 0600。该快照明确排除未受本次变更影响的大型遥测表 `request_metrics`，不称全库备份；较早中止的 `database-snapshot.partial.gz` 不可作为恢复依据。不得整库回退覆盖后续业务或其他会话已确认的数据清理。
- 维持现有 `DB_SYNCHRONIZE=true`，已核对 `work_order_material_drafts` 和 `stock_reservations` 两表及唯一/查询索引存在，核验时均为 0 行。正式后台现有登录会话只读 GET 工单 #182 的草稿返回 `version=0, rows=[]`，库存选项返回 18 项；已完成列表 `sort=newest` 实际返回的 100 条按 `completedAt` 倒序，员工端再截取最近 50 条。没有添加、删除生产用料，也没有发送测试通知。
- 员工 AppID `wx002fde4bfaa4c7d9`，微信 CLI 成功上传 **`1.0.20261111d · 1e953e2a`**，包大小 1,097,076 字节、构建 `warnings=[]`，提交时间 12:40:03；上传后还原构建标记，源码干净。12:48 重新读取公众平台「版本管理」，开发版本 d 已显示「体验版 / 扫描访问体验版」，备注带 `1e953e2a`，不需要再次切换。未提交审核或正式发布。此前 c 的发布记录与上传时「未核对」状态均为历史时点记录，以此次刷新核验为准。
- `deployed/api`、`deployed/miniapp-staff` 已推送并回读确认指向 `1e953e2a`。正式 Web 仍为 `2.0.20261110-1025 · 665a99e8`，助手在线清单仍为 `2.5.52 · cf44af3f`；本次未升级。截图与脚本保存在主目录 `.tmp/material-reservation-evidence-20261111/`，其中 `experience-version-d.png` 是公众平台实际版本截图，`material-preview.png` 是合成数据模拟器布局截图。
- 验证边界：发布门禁及已有 27 项相关测试通过；真实登录后的生产只读接口、表结构、版本和配置指纹已核验。Windows 本地 PostgreSQL 启动拒绝仍阻塞真实并发测试；手机重新进入体验版、添加用料后返回重开、删除释放预留及完工落账尚未现场验收。上线健康与模拟器截图不代表这些写入业务已完成手机验收。

## 2026-11-11：抄表入口隐藏回归

- 用户报告 d 版抄表菜单消失。已复现：`rememberAccess` 把服务端 `app:meters.view=true` 过滤掉，底部组件因此隐藏抄表；仅授权抄表的账号还会被 `hasPmsAppAccess` 误判为没有 PMS 权限。不是抄表页面或路由被删除。
- 来源查证：`83332323` 曾通过共用注册表修复该问题，后续主线 `c4cb9d8e` 合入审批权限拆分时改回手写缓存清单，漏掉 `app:meters`、`app:order-rollback`、`app:order-void`。d 版上传源 `1e953e2a` 是当时已推送主线，但含此回归；此前发布只验用料卡片，未验完整菜单，属于发布验收遗漏。撤回/作废按钮原本直接读原始权限，漏缓存不等于常规角色的按钮已失效。
- 范围核查：与上一已知公开源码 `17ae188a` 比较，27 个页面、5 个原生底部路由均保留，无删除；与修复前最新 `origin/main=47b6c44c` 比较员工端运行源码无差异。不能据此声称每项业务都已手机验收。
- 恢复使用 `@pms/shared-types` 的 `STAFF_APP_PAGE_KEYS` 共用注册表，保留新旧审批权限与外部应用隔离。回归 `node --test apps/miniapp-staff/test/tabbar-access.test.cjs` 首次复现 3 项失败，修复后 5 项通过：旧缓存刷新、仅抄表账号、全部 10 个组件入口、逐项授权/撤销和外部应用专用账号。抄表读数、复核、定位及库存默认筛选 17 项相关测试和员工端类型检查通过。后续发布前必须执行此完整入口回归，不能仅验本次局部页面。
- 扩查本轮用料功能另发现：`saveMaterialDraft` 选用了微信请求层明确拒绝的 PATCH；此前只测浏览器 HTTP 接受，未经过微信真实请求层，不能算手机保存已通。新增 `material-draft-transport.test.cjs` 首次复现「小程序不支持 PATCH 请求」，HTTP 回归首次复现 PUT 入口 404。修复为客户端 PUT，服务端新增同权限/同 DTO/同服务事务的 PUT 别名，保留原 PATCH 兼容其他端；没有放宽权限、模拟生产保存或修改请求层的安全限制。新增两项回归与原有草稿/持久化/预留/库存账本共 24 项通过；不冒称真实生产库存写入或多连接并发已验证。
