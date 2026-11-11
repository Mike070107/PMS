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
