# 房产档案、业主与电话（2026-11-11）

## 已确认的业务规则

- 管理处 → 小区/公寓 → 住宅楼 → 房号 → 业主；商铺直接关联业主，不生成虚拟房号。
- 房产与业主是多对多：一处房产多位业主、一位业主多处房产/商铺。
- 业主姓名、主要联系电话、其他电话共用一份档案。手机号对应登录身份的原有规则保留，其他联系电话不自动成为登录凭据。
- 房产列表中“解除关联”只移除当前房产关联，不停用整个业主；房号归档可恢复，管理处/小区/楼栋有从属数据或历史记录时不能直接删除。
- 有房号的楼栋不能直接改商铺；有关联业主的商铺不能直接改住宅楼。历史数据迁移必须单独核对，不能静默丢关联。
- 联系记录按号码保存。`最近业务使用`不代表接通；`最后联系成功`仅由管理员登记实际成功联系更新。未接通、无效、停用保留此前成功时间。

## 实现与兼容

新版 `/houses` 使用 `PropertyArchive.tsx`，五级 TAB、父级筛选、分页、表单及权限独立控制。
管理处复用 `/offices` 权限；其余档案复用 `properties` 权限。接口继续核对租户与管理处范围。

分类保存在 `communities.community_type` 和 `buildings.building_type`；房号仍复用原 `houses`。
多对多关联保存在 `owner_property_links`。原 `users.house_id`、新增商铺代表字段仅用于旧入口兼容，
读取时合并关联表和代表字段；新增关联不覆盖已有房产。解除代表房产时从剩余关联中选取代表，其他关联保留。
不同管理处共用的业主，接口只返回授权范围内的房产；受限账号不能停用/恢复还有范围外房产的整份业主档案。

电话集合为 `users.phone` + `contact_phones`（去重）。联系结果写入 `owner_phone_activity` 和
`owner_phone_events`，时间由服务器产生，事件保留操作人。报修保存、公寓收费使用电话时记录业务使用，
查询档案时还合并真实报修记录中的使用时间，覆盖报修时首次补建的档案。浏览、搜索、自动填表不标记接通。

数据库制品：`1795900000000-PropertyArchiveHierarchy.ts`；对应表也已登记 TypeORM 实体，兼容本地 synchronize。
迁移可重复执行，保留已编辑的电话、已有房产关系和联系时间。回退前必须备份这些新增数据，不能直接执行 down 丢弃新关联。
**不按名称猜测公寓/商铺分类**；存量默认小区/住宅楼，发布后必须在档案中核对并设置真实分类，才能使用公寓统计范围。

## 公寓收费与下钻

公寓收费台的收费明细、收费报表、财务对账均携带 `communityType=apartment`。
服务端以房产档案中的公寓 ID 与账号范围取交集，列表、合计、导出及报表下钻共用该范围。
普通收费页不传分类，保留原有范围。公寓分类不是额外的数据访问授权。

财务对账支持区间实收、收款、退费、流水笔数/天数、按日、收款方式及合计下钻。
下钻复用 `/fees/reports/detail`，对账固定 PMS 来源以匹配对账原有口径；保留日期、项目、分类和方式条件，
支持分页、错误重试和窄屏内部滚动。金额与合计使用同一分值，不把分页小计当总额。

## 可执行回归与现场缺口

```powershell
pnpm --filter @pms/api exec node -r ts-node/register --test src/modules/owners-mgmt/property-archive.persistence.test.ts src/modules/properties/properties-office.test.ts src/modules/properties/properties-delete.test.ts src/modules/fees/cashier-finance.persistence.test.ts src/modules/fees/cashier-finance.test.ts src/modules/fees/cashier.util.test.ts src/modules/repairs/repair-owner-phone-sync.test.ts
node --test apps/neighbor-web/test/property-archive-browser.test.cjs apps/neighbor-web/test/apartment-reconciliation-browser.test.cjs
pnpm --filter @pms/neighbor-web typecheck
pnpm --filter @pms/admin-web typecheck
pnpm --filter @pms/api exec tsc --noEmit
```

SQL 回归在隔离 PGlite 中执行真实迁移、TypeORM 保存与读取；浏览器运行真实页面、表单、路由和下钻组件，
仅替换 API/身份适配器，禁止访问真实业务系统。截图位于 `outputs/property-archive/`、`outputs/apartment-reconciliation/`。

本批已获用户生产发布授权，使用独立整合工作树合并停车增量，不包含现场助手或小程序未提交工作。完整 API 与根路径 neighbor-web 构建已通过，原 esbuild 临时文件阻塞未在整合目录复现；真实业务现场验收与正式发布后核验分别记录，不能以隔离回归替代。

## 已确认的首次生产分类

用户确认馨香臣寓吴泾、颛桥、马桥、江川四店，另加吴泾一村为公寓；锦川公寓仍为普通住宅小区。精确租户/ID/名称在 `deploy/production-apartment-scope.json`，不按名称自动推断其他档案。先完成 PostgreSQL 原生备份并核对归档清单，再在事务内执行原迁移与 `deploy/property-archive-release.cjs` 分类；名称或ID不符则整批拒绝，回读确认后按 API → Web 发布。

后续修改必须先成功 fetch origin/main，从最新远端 main 建独立工作树。推送使用普通快进，发布使用 main 专用干净副本；现有 release-check 同时核对远端受影响源码及 deployed 标签祖先，禁止旧基线覆盖新功能。主目录未提交工作不得用 stash/reset/整包提交清理。
