# 多租户用户权限体系设计（RBAC + 数据范围）

> 2026-08-10 与 Mike 逐项确认定稿。实施进度见文末。

## 定位

平台化 SaaS：软件开发企业（平台方）服务多家物业公司（租户），
物业公司内按管理处划分管辖小区。

```
平台（superadmin，tenant_id = null）
 └─ 物业公司（tenants 表，企业租户）
     └─ 物业管理处（management_offices 表，一个管理处管多个小区）
         └─ 小区（communities，顶层小区挂 office_id；下层分期不动）
             └─ 楼栋 → 单元 → 房号
```

## 已确认的设计决策

| 决策点 | 结论 |
|---|---|
| 与现有 `users.role` 的关系 | **双轨制**：`role` 保留为「业务身份」（小程序登录、派单、代报），新增独立「后台角色」只管网站权限 |
| 数据范围绑在哪 | **绑角色**：角色 = 功能权限矩阵 + 数据范围（全公司 / 指定管理处 / 指定小区） |
| 权限动作粒度 | **三档**：查看 / 编辑（含新增修改）/ 删除；无查看权则菜单隐藏、接口 403 |
| 页面结构 | **一页整合**：员工管理升级为「用户管理」（业务身份/工种/在岗 + 后台角色绑定同页） |
| 管理处层落地 | **新建独立表** `management_offices`，顶层小区挂 `office_id`，不动现有小区数据 |
| 分级管理 | **一期简化版**：只有企业超管建角色；有用户管理权的管理处角色只能在自己范围内管人、只能分配范围不超过自己的角色 |
| 数据范围过滤的模块 | 工单管理、房产与业主 + 业主审核、楼栋报修码、工作台统计（材料/库存是仓库维度，暂不过滤） |
| 平台端形态 | **同一后台加「平台管理」菜单组**，仅 superadmin 可见 |
| 平台代操作 | **租户切换**（Salesforce "Login As" 式）：进入公司视角用现成页面操作，顶部常驻提示条 + 一键退出 + 审计日志 |
| 公司级功能限制 | **每公司直接勾选可用页面**（`tenants.enabled_pages`），公司内角色只能在此范围内分配；套餐模板二期再说 |
| superadmin / 企业超管 | 不受权限矩阵限制，直通；每公司内置不可删「企业超级管理员」角色 |

## 数据库改动

| 对象 | 说明 |
|---|---|
| `management_offices` 新表 | tenant_id, name, remark, enabled |
| `communities.office_id` | 新字段，顶层小区 → 管理处，可空 |
| `roles` 新表 | tenant_id, name, remark, data_scope(`all`/`offices`/`communities`), built_in, enabled；(tenant_id, name) 唯一 |
| `role_permissions` 新表 | role_id, page_key, can_view, can_edit, can_delete；(role_id, page_key) 唯一 |
| `role_scopes` 新表 | role_id, office_id(可空), community_id(可空)；选管理处 = 自动含其下全部小区（含后来新增的） |
| `user_roles` 新表 | user_id, role_id 多对多，权限取并集 |
| `tenants.enabled_pages` | jsonb，可用页面 key 数组；null = 全部可用 |
| `platform_logs` 新表 | 平台代操作 / 租户切换审计 |

Schema 变更方式：本次起引入 TypeORM migration（`src/migrations/`），不再依赖 synchronize。

## 鉴权链路

- 后端：`@RequirePermission('page-key', 'view'|'edit'|'delete')` + PermissionsGuard；
  superadmin / 企业超管直通；旧 `@Roles` 在过渡期共存，管理后台接口逐步替换。
- 登录及 `/auth/me` 下发：权限清单（page → 三档布尔）+ 可见小区 id 集合 + 可用页面。
- 数据过滤：范围解析为小区 id 集合后注入查询（工单/房产/审核/楼栋码/工作台统计）。
- 前端：菜单按「查看」过滤，页内编辑/删除按钮按权限显隐；`NAV_GROUPS` 与 `PAGE_TITLES` 合并为单一带 pageKey 的配置。
- 租户切换：superadmin 请求携带目标租户标识，后端校验身份后以该租户上下文执行并记 `platform_logs`。

## 存量兼容

- 现有租户 = 第一家物业公司，`enabled_pages` 默认全部。
- 每公司自动种子「企业超级管理员」内置角色。
- 存量 manager/office 等后台账号自动绑「全功能（兼容）」角色，避免上线即白屏，后续人工收紧。

## 业界参照

- 若依/芋道：菜单权限 + 数据权限（全部/自定义/本部门/本部门及以下/仅本人）双轨模型，租户管理 + 租户套餐。
- 多租户 RBAC：角色带 tenant_id、(tenant_id, name) 唯一、查询层强制注入范围。
- 代操作：two-token / server-side "Login As"，UI 明显标识 + 审计。

## 实现要点（2026-08-10 完成）

- 守卫三件套（`modules/access/`）：`PermissionsGuard`（纯管理端接口）、
  `RolesOrPermissionGuard`（小程序+后台共用接口：业务身份 @Roles 或页面权限任一命中）、
  `PlatformGuard`（仅 superadmin）。范围过滤统一走 `scope.util.ts` 的 `scopeCommunityIds()`。
- 例外约定：**采购审批链（提交经理/经理批/采购批/驳回）、下单、收货、调拨审批
  仍按业务身份 @Roles 把关** —— 这是审批流程语义，换页面权限会让"谁都能替经理批"。
- 兼容种子：`rbac-seed.service.ts` 每次启动幂等执行 —— 每公司种内置「企业超级管理员」；
  存量 manager/office/purchaser 无绑定则自动挂「全功能（兼容）」角色，之后人工收紧。
- 登录准入：owner/technician 默认不能登后台，但绑了后台角色即放行（adminLogin）。
- 租户切换：superadmin 带 `x-acting-tenant-id` 头（jwt.strategy 替换 tenantId），
  进入/退出由 `/platform/tenants/:id/enter|exit` 记 `platform_logs`；
  前端 localStorage `pms.admin.actingTenant` + 顶部橙色提示条。
- 前端权限：`lib/auth.ts` 存 `pms.admin.access`（登录后和每次进后台刷新自一遍 /auth/me），
  `usePagePerm(pageKey)` 控制按钮显隐；菜单唯一配置源在 `AppLayout.tsx` 的 NAV_GROUPS。

## 实施进度

- [x] ① 实体 + 首条 migration
- [x] ② 后端权限框架（守卫、下发、角色/用户/管理处 CRUD）
- [x] ③ 平台层（租户管理、企业超管开通、可用页面、租户切换+审计）
- [x] ④ 数据范围过滤
- [x] ⑤ 前端（菜单/按钮权限、角色管理、用户管理、管理处、平台菜单组）
- [x] ⑥ 存量兼容种子 + 构建验证

## 层级澄清与补齐（2026-08-19 与 Mike 确认后实施）

完整层级：平台公司 → 物业公司(tenants) → 管理处/项目部(management_offices)
→ 小区(communities，含分期 parent_id) → 弄 → 楼栋(buildings) → [单元(units)可选] → 房号(houses)。

已确认的两条「不改」决策：

- **弄不升级为独立表**：弄是 `buildings.lane` 字段（上海式门牌「228弄26号101室」），
  同小区内弄+号组合唯一即可；除非以后要在弄级挂管理属性（弄级报修码/责任人）再拆表。
- **角色、订阅消息不下沉到管理处级**：角色 = 公司级表 + 数据范围限定已能表达
  「各管理处各有各的角色」；订阅消息跟人走，无需挂管理处。

本次补齐的三件事（migration `1787443200000-TenantExpiryAndBusinessScope`）：

| 事项 | 实现 |
|---|---|
| 租户服务有效期 | `tenants.expires_at`（date，含当天，null=永久）。到期/停用后 **jwt.strategy 逐请求拦截全员（含小程序）**，superadmin 不受限（要能进去续期）；adminLogin/员工登录处另给友好文案。平台租户页可设置，列表红/橙标注已到期与 30 天内到期 |
| 前台收费接入数据范围 | `business_transactions.community_id` 新列（按房号→楼栋→小区回填存量）；规则/流水/搜索（房号、车辆、门禁卡按所挂房号的小区 join）全走 `scopeCommunityIds`。受限角色：只见「公司通用 + 范围内小区」规则、只能建/改绑定在范围内小区的规则、办理时校验房号在范围内；规则绑小区后办理时校验适用性 |
| 管理处切换器 | 顶栏 Select（`x-acting-office-id` 头）：`AccessService.applyActingOffice` 把数据范围收窄到该管理处的小区集合（与本人范围求交，**只窄不宽**，无效值静默忽略）；`/auth/me` 下发 `offices` 可切列表；`RolesOrPermissionGuard` 角色路径命中时若视角生效也挂 req.access（否则企业超管在工单共用接口上切了没效果）。全部小区数据页自动生效，无需逐页改造 |

管理处切换器的显隐规则：本人范围覆盖 ≥2 个管理处，或全公司范围且存在管理处。
localStorage key：`pms.admin.actingOffice`；切公司视角、退出登录、角色变更后失效自动清。
