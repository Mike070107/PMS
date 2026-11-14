# PMS 本批交接（2026-11-14，本次已授权发布，进行中）
## 目标
换牌不改车型/授权/独立 PMS 计费类别，新增独立修改车辆类型；主控单写，保留原团队和所有脏树。
## 已完成
候选分支 fix/vehicle-type-preservation-20261114；未 commit/push/deploy，未修复或重放事故车辆。
API 白名单、完整回执、能力门槛、原幂等请求不可变；敏感任务首次绑定原助手，只允许其恢复本地快照。
助手 Serializable 原值参数/全字段读回/漂移回滚，typed DPAPI 写前不可覆盖快照；损坏快照停止恢复。
PMS 计费 partial 保留原牌类别及新牌精确临时映射，全部来源成功后才迁移原 ID。
新旧换牌/独立车型入口、写前持久 journal、原任务恢复、失败保留、写后独立查询；新UI390/320溢出已修。
API 完整核心252/252、保护专属15/15，新旧Web类型检查、源码回归3/3、助手Release+self-test全部通过；最终浏览器27项通过。
双Web保持默认压缩/target等价构建成功；用进程TEMP管道回退绕开esbuild临时文件删除异常，未修改权限/依赖。
只读复审：原agent pin P1已修、增量复核未发现其余P0/P1。
## 进行中
本批本地验收已收齐；已切换自有lead/browser-check/preservation-review团队，原团队保留；源码冻结候选待集成。
## 待办与未完成层
真实API/SQL Server存储过程、真实PostgreSQL并发、现场助手跨进程故障恢复、设备/刷卡尚未验收，不能宣称现场闭环。
原助手或快照丢失、云端原任务未知/失败均需人工核对；禁止换助手/换新键猜测重办。
用户22:49明确授权发布本批API/Web/助手更新包；不写业务测试/不重放事故5045/task153，不覆盖原始工作树候选。
## 关键文件与证据
[总验收与风险](<../../outputs/vehicle-preservation-verification.md>)；[浏览器汇总](<../../outputs/vehicle-preservation-browser/verification.json>)。
[最终构建日志](<../../outputs/browser-check-20261114/vite-build-final.utf8.log>)；[等价构建runner](<../../outputs/browser-check-20261114/vite-build-in-memory-config.cjs>)。
[API保护回归](<../../apps/api/src/modules/access-card-issuance/parking-vehicle-preservation.test.ts>)；[浏览器回归](<../../apps/neighbor-web/test/preservation-browser.test.cjs>)。
## 验证命令
API：`node -r ts-node/register --test src/modules/access-card-issuance/parking-vehicle-preservation.test.ts`（apps/api）。
UI：`node --test test/preservation-browser.test.cjs`（apps/neighbor-web）；构建：`node outputs/browser-check-20261114/vite-build-in-memory-config.cjs`（root）。
## 下一轮
先读此交接及总验收；由lead主控，browser-check负责只读浏览器/构建，preservation-review负责只读审查；保留原团队不删除。
