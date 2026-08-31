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
| 与现有 `users.role` 的关系 | ~~双轨制~~ → **2026-08-26 合并为一张表**，见文末「业务身份与后台角色合并」 |
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


## 角色 = 名字 + 勾好的页面 + 数据范围（2026-08-26 定稿）

**推翻上表第一行的「双轨制」；同日曾短暂引入过「角色类型」字段，也已删除。**

起因：后台把人改成维修工，员工端底部照旧是「派单台 / 材料与库存」。
根因是双轨制：tab 显隐读 `users.role`，后台改的是另一条轨，两套东西同名不同义。
中间版本把 `users.role` 并进角色表叫 `business_role`（角色类型），用来区分
「接单还是派单」「谁批第一步」—— 那等于让配角色的人多填一个字段才能表达本来
勾一下就能表达的事。Mike 的原话：**角色只是一个名称，勾对应的页面权限和数据范围，
用户选角色名就自动继承**。最终就是这样。

| 决策点 | 结论 |
|---|---|
| 角色是什么 | `roles` 表：名字、备注、数据范围、启用。**没有类型字段** |
| 权限矩阵 | `role_permissions` 一张表管两端。网站页面 key 不变；员工端入口 `app:` 前缀，共 8 格（见下） |
| `users.role` | 降级为**哪个端**：`owner` / `staff` / `superadmin`。员工一律 `staff`，能干什么只看角色绑定 |
| 企业超管 | 绑内置「企业超级管理员」角色 = 全权限直通。不再有 `role='admin'` |
| 接口鉴权 | 员工侧一律 `@RequirePermission`（后台 key 与 `app:` key 并列写在同一个装饰器上）。`@Roles` 只剩 `OWNER` 一种用法 —— 业主没有角色可绑，只能按端放行 |
| 「谁是维修工」 | 不存在这个问题。派单候选人 = 有 `app:pool·接单` 的人；缺料通知发给有 `app:dispatch·派单` 的人；待批提醒发给有对应审批格的人（`AccessService.userIdsWithPermission`） |
| 数据隔离 | 「只能看自己提的单」= 业主，或员工侧**既没有工单池也没有派单台也没有后台工单管理**的人（`repairs.service.isSelfScoped`）。以前写死一份身份名单，新增一种代报身份漏加就会掉进无过滤分支 |
| 一人几个角色 | 随便绑，权限取并集。没有「一个人只能一个身份」的限制了 |
| 权限模板 | `role_templates` + `role_template_permissions`：**只管页面权限**，不含数据范围、不能分配给人。角色 `roles.template_id` 有值 = 权限跟随模板（角色自己不存 `role_permissions`，`AccessService.effectivePermissions` 每次现读，改模板下一次请求就生效）；留空 = 自定义（老行为）。几个管理处的同一类角色选同一个模板，之后改权限只改模板一处。解绑回自定义时把模板当前那份固化成角色自己的；模板被跟随时不允许删除。关联一律手动 —— 自动把同名角色挂上去等于悄悄改一批人的权限。后台在「业务角色 → 权限模板」页签，带「导入开箱模板」和角色行的「存为模板」 |
| 开箱即用 | `DEFAULT_ROLE_TEMPLATES`（shared-types 与 api 同源）：维修工 / 物业办公室 / 物业经理 / 采购经理 / 保安 / 居委会 / 业委会。**只是初始值**，改名改勾选删掉都行；每公司只种一次（`tenants.rbac_seeded_at`），种子不会覆盖后来的调整。新建角色时输入这些名字会自动套模板 |

### 员工端的 8 格

| key | 入口 | 可操作那一档 |
|---|---|---|
| `app:pool` | 工单池 | 接单 |
| `app:dispatch` | 派单台 | 派单（指派、改期限） |
| `app:my-orders` | 在手工单 / 我的报修 | 处理工单（完工、报缺料） |
| `app:repair-create` | 报修 | — |
| `app:inventory` | 材料与库存 | 改材料 / 提采购 |
| `app:approve-manager` | 采购审批（经理这一步） | 批 / 驳回 |
| `app:approve-purchaser` | 采购审批（采购这一步） | 批 / 驳回 |
| `app:messages` | 消息中心 | — |

工单池和派单台是同一个页面的两种模式（tabBar 点哪格写 `pms.staff.poolMode`）；
两格都有权限时底部两格都显示。审批页两步都有权限时先看经理那一步。

### 后台这两页

- **业务角色**：列表 = 角色 / 数据范围 / 能看到什么 / 绑定用户 / 备注。编辑弹窗 = 名称、备注、数据范围、
  两个页签的页面权限（Web / 邻修小程序），每行一个页面主勾选，勾中就地展开细分档。
- **用户管理**：只有一列「业务角色」；筛选按角色 id。编辑弹窗里「要不要账号密码」「要不要可代报小区」
  都从所选角色的勾选推导（`/roles/assignable` 带 `hasAdminPages` / `appPageKeys`）：
  勾了网站页面的必须有账号密码；既没工单池也没派单台的是"只报修的人"，要配可代报小区。

### 「勾得出来就必须真的生效」

矩阵里能勾的每一档，端上都有人消费，后端接口也按同一批 key 鉴权。被权限收起来的按钮都配了
`.notice` 说明，写清「去业务角色页哪一行勾什么 + 下拉刷新即可」。

### 上线前踩过的几个坑（多智能体审查发现，均已修）

- 曾在守卫里做「`app:inventory` 等价于 `inventory`」的通用映射，勾个「报修」就能派单 —— 改为接口上显式列 key，守卫不做映射
- 种子每次启动都跑会回滚管理员的调整 —— 改为每租户只种一次
- 按名字认领同名角色会把后台权限发给全体维修工 —— 改为同名已存在就一个字不动
- 平台新开的公司当天建不了员工 —— `createTenant` / `bootstrapAdmin` 直接调种子
- 停用一个还有人绑着的角色会让这些人两端都进不去 —— 有人绑着就拦下并说明
- 一家公司数据出错会中断全平台迁移 —— 逐租户容错

## 数据范围之外的一格：角色额外可见的仓库（2026-08-30）

`role_scopes` 只能圈到管理处和小区。总仓的 `warehouses.office_id` 是空的，而受限角色
能看到哪些仓正是按 `office_id` 匹配的 —— 所以「让『枫桦景苑办公室』（范围 = 枫桦景苑管理处）
用总公司那个总仓」，数据范围**表达不出来**。

新表 `role_warehouses`（role_id, warehouse_id，migration `RoleExtraWarehouses`）补这一格：

| 点 | 结论 |
|---|---|
| 配在哪 | 业务角色编辑，数据范围不是「全公司」时出现「额外可见的仓库」多选；选项带归属（`总公司陈峰处总仓 · 总仓`） |
| 谁来合并 | `AccessService.extraWarehouseIdsOfUser` 取本人所有角色的并集 |
| 谁消费 | `InventoryService.visibleWarehouseIds`（后台库存清单）、`filterWarehousesForUser`（员工端库存页） |
| 与管理处视角的关系 | **正交**。顶栏切了某个管理处只收窄「按管理处算的那部分」，这里点名的仓一直可见 —— 它是角色本身的授权，不属于任何一个管理处 |
| 全公司范围的角色 | 配了也不多给，本来就全看得到 |

为什么不做成「按管理处共享仓库」：那个粒度下同管理处的所有角色（办公室、维修工、经理）
一起获得，表达不了「只给办公室」。2026-08-30 Mike 选了按角色。

顺带记一处本来就存在、现在才对齐的不一致：维修工在工单里选料的匹配链是
「同小区仓 → 同管理处仓 → 公司总仓」，也就是**领料时总仓一直能兜底用**，
只是库存清单看不到。现在两边口径一致。
