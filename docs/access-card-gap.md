# 门禁卡管理差距盘点（旧发卡页 vs 当前 beta 页 vs 两个外部库）

> 盘点日期：2026-11-06
> 盘点人：access-db
> 范围：只读调查 + 本机已有备份/骨架代码，未连接生产库、未写入实体卡、未 commit。
> 结论先行：**11 项目标功能里，只有「发卡 / 读写卡 / 按房号查询」有实现；延期、挂失、解挂、注销、换卡、补卡、批量导入、导出全部没有接口、没有 Agent 任务、没有写库实现。** 当前 beta 页还把旧发卡页的权限管理、远程开门、设备状态、最近 30 条、代理注册、模拟模式整块覆盖掉了。

---

## 0. 代码定位（证据）

| 角色 | 路径 | 说明 |
|---|---|---|
| 旧发卡页 | `apps/admin-web/src/pages/AccessCardIssuancePage.tsx`（1749 行） | git 历史中唯一一版门禁发卡页；`git log --all --follow` 自 `b8015bfc` 起逐步迭代到 `04a589c0`，**从未被删除**，仍在 admin-web `/access-cards` 路由（`apps/admin-web/src/App.tsx:180`） |
| 旧页辅助 | `apps/admin-web/src/pages/access-card-controller-state.ts`、`apps/admin-web/test/access-card-controller-state.test.mjs` | 逐栋控制器结果折叠/排序 |
| 当前 beta 页 | `apps/neighbor-web/src/pages/AccessCards.tsx`（258 行） | neighbor-web 正式发布目标（`deploy/publish-production.ps1`），只保留发卡/历史/重试 |
| 后端模块 | `apps/api/src/modules/access-card-issuance/` | 发卡批次 + 代理任务 + 历史授权 + 停车（停车与门禁卡无关，勿混改） |
| Windows 代理 | `tools/access-card-agent/` | issuer / access_gateway / legacy_sync / parking_gateway 四种身份；.NET Framework 4.0 / C# 5 / x86 |
| Access 实验工具 | `tools/access-db-lab/` | 本机 OleDb 只读探测、写入实验、WG 控制器报文工具 |
| 设计/交接文档 | `docs/access-card-automation-design.md`、`docs/access-card-automation-handoff.md`、`docs/access-card-writer-implementation-plan.md` | 大量现场只读证据与验收边界，本文引用均出自这三份 |

git 调查补充：`git log --all --diff-filter=D --name-only` 中**没有**被删除的门禁页；2025 年 Flask 旧系统 tag 中也没有门禁模块。所谓「旧发卡页」就是 admin-web 的 `AccessCardIssuancePage.tsx`，beta 版指的是 neighbor-web 的 `AccessCards.tsx`（提交 `4d990ba2` 把 beta 收费工作台合入 main 时新增，`597013f7` 起以独立「门禁管理」页出现）。

---

## 1. 旧发卡页完整功能清单（逐项）与 beta 对照

标注：✅ 已有；⚠️ 行为不一致/缩水；❌ 缺失。

### A. 选房与上下文

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| A1 | 房产地址选择器，选到具体室号 | ✅ 有（`HousePicker`） | 旧 L1295-1326 / beta L133-138 |
| A2 | 选房后显示 `弄/楼/室`、小区、项目期数（一期/二期）、门禁系统（MjSystem/iCCard/只写卡） | ⚠️ 只显示小区+楼+室；无期数/门禁系统标签 | 旧 L1309-1322 / beta L149-153 |
| A3 | `routeReady` 不满足时禁止开始并提示缺少映射 | ❌ beta 不校验 `routeReady`/`canStart`，工作站离线也能建批次 | 旧 L489-490、L1377 |
| A4 | 历史记录来源提示（PMS/`.80` 旧库/`.88` 权限核验）与「刷新历史」 | ❌ beta 无来源提示、无刷新按钮；仅首次加载 | 旧 L1480-1522 |
| A5 | 旧库首次查询未回传时最多 8 次、每次 1.25 秒的有界轮询 | ❌ beta 一次性请求，慢网下可能长期空历史 | 旧 L434-446 |

### B. 设备与服务状态

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| B1 | 三块健康状态砖：发卡器 / `.80` 捷顺库写入 / `.88` 门禁库+控制器下发 | ⚠️ 只有一个「发卡工作站在线/离线」tag | 旧 L1160-1194 / beta L128-130 |
| B2 | `readiness` 的 `simulationEnabled`、`features.cardWrite/legacyDbWrite/accessDbWrite/controllerUpload` 分项展示 | ❌ beta 丢弃 | 旧 L121-129、L1160-1194 |
| B3 | 「重新检测」按钮 | ❌ 丢弃 | 旧 L1156 |
| B4 | 下载发卡小助手 / 加密初始化助手 | ❌ 丢弃 | 旧 L1134-1146 |
| B5 | 注册本地服务（issuer / access_gateway / legacy_sync 三类，一次性密钥、安装说明） | ❌ 丢弃 | 旧 L448-471、L1695-1746 |
| B6 | 选择发卡工作站（`workstationId` 绑定在线在线 issuer） | ❌ beta 自动取第一个 online issuer，不能选 | 旧 L483-490、L612-618 / beta L47-56 |

### C. 发卡流程

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| C1 | 发卡数量步进，**范围 1–6** | ⚠️ 范围 1–20（`Math.min(20, …)`） | 旧 L1336-1339 / beta L157-158 |
| C2 | 额外授权楼栋多选（仅二期；本楼栋默认只读） | ❌ 丢弃，固定传 `extraBuildingIds: []` | 旧 L1343-1358 / beta L96-102 |
| C3 | 主按钮按数量变文案、能力未就绪时禁用 | ❌ 只要选了房就能点 | 旧 L1360-1377 / beta L160-162 |
| C4 | 批次进度：当前第 N 张、请放卡、逐张状态条 | ✅ 基本保留 | 旧 L1382-1478 / beta L165-201 |
| C5 | 重复卡检测后停止本次发卡、显示原用户/房号/捷顺编号 | ⚠️ beta 只显示通用错误文案，不展示重复卡归属 | 旧 L1391-1397 / beta L195-197 |
| C6 | 写卡/门禁/旧库三状态轴分列、原始状态码 title | ✅ 有（`access-card-status.ts`） | beta L174-190 |
| C7 | 「发卡完成，可以交付」对二期要求**控制器全部确认**后才出现 | ❌ beta 只要 `card_completed` 就显示完成，无交付判定 | 旧 L1398-1404、L221-229 / beta L83-84 |
| C8 | 门禁下发失败时单张「重试」 | ✅ 有（限 `waiting_retry/needs_operator/permission_check_failed/not_uploaded`） | 旧 L1426-1442 / beta L178-188 |
| C9 | 模拟模式：模拟放卡、模拟同步 `.80` | ❌ 丢弃 | 旧 L1460-1473、L628-736 |
| C10 | 「开始下一次发卡」按 `batch.deliverable` 放行 | ⚠️ beta 的「结束 / 看结果」不校验可交付 | 旧 L1373-1375 / beta L199 |

### D. 历史卡与楼栋权限（旧页核心，beta 几乎全丢）

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| D1 | 历史列表：序号/房号/捷顺编号/IC/WG/发卡时间/控制器权限/旧库同步 | ⚠️ beta 只剩序号/卡号/时间/门禁/旧库，**无 WG 单独列、无逐栋权限、无捷顺编号列** | 旧 L1056-1098 / beta L232-251 |
| D2 | 逐栋控制器结果展开（`+N` / 收起） | ❌ 丢弃 | 旧 L195-253 |
| D3 | 「添加至门禁管理系统」（`.88` 库写入，`access_database_only`），失败可重试 | ❌ 丢弃 | 旧 L996-1016、L1074-1082 |
| D4 | 「下发至控制器」（先写库再上传，`controller_upload`），失败可重试 | ❌ 丢弃 | 旧 L918-994、L1083-1092 |
| D5 | 「管理权限」弹窗：按楼栋勾选增/删权限，逐栋结果、仅重试未完成门栋 | ❌ 丢弃 | 旧 L1621-1693、L806-916 |
| D6 | 历史行按 `issuedAt` 倒序、一期WG/权限显示「不适用」 | ⚠️ beta 用后端顺序，一期也不显式标注「不适用」 | 旧 L757-765 / beta 直出 |

### E. 最近记录

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| E1 | 「PMS 最近 30 条发卡记录」（含 WG、捷顺编号、控制器状态、旧库状态），可刷新 | ❌ 丢弃 | 旧 L1526-1552 |
| E2 | 「捷顺数据库最新 30 笔发卡记录」（`.80` `MC.CardInfo` 只读）；再叠加 `.88` 权限核验；可「添加至门禁系统/下发控制器」 | ❌ 丢弃 | 旧 L1554-1619 |
| E3 | 最近记录轮询（1.5s）直至 `.80`/`.88` 快照就绪 | ❌ 丢弃 | 旧 L353-362 |

### F. 门禁远程控制（不依赖房号）

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| F1 | 选楼栋 → iCCard 检测设备 / 远程开门 / 临时常开（5/30 分钟、1/8/24 小时，可自定义分钟） | ❌ 丢弃 | 旧 L1197-1293 |
| F2 | MjSystem 立即远程开门（二次确认）；检测/常开明确拒绝 | ❌ 丢弃 | 旧 L519-577 |
| F3 | 临时常开到期自动恢复任务（服务端持久化，网关离线重连后恢复） | ❌ 丢弃 | `docs/access-card-automation-handoff.md` §10 |

### G. 安全与状态语义

| # | 旧页面功能 | beta 现状 | 证据 |
|---|---|---|---|
| G1 | 一期只写卡（`not_required`），二期才走 `.88` 权限 | ⚠️ 后端保留，页面无提示 | 设计文档 §2.2 |
| G2 | 旧库同步不阻塞交付、失败告警可重试 | ⚠️ 后端保留，页面无独立重试入口 | 设计文档 §6.4 |
| G3 | 卡片查重（PMS 全租户 + `.80` 全库，含孤立卡） | ✅ 后端保留 | `cardPreflight` |

---

## 2. 目标 11 项功能逐项差距

> 「接口」= 当前 PMS 已有或需要新增的 HTTP 接口；「数据表」= PMS 表 + 外部库表；「状态」分：已实现 / 部分实现 / 未实现。

### 2.1 发卡 —— 部分实现

- 旧页面：✅（数量 1–6，额外楼栋，进度，重试）
- beta：⚠️（数量 1–20，无额外楼栋，无能力门禁）
- 接口：
  - `POST /api/v1/access-card-issuance/batches`（`CreateAccessCardIssueDto`）
  - `GET /api/v1/access-card-issuance/batches/:id`
  - `POST /api/v1/access-card-issuance/batches/:batchId/items/:itemId/retry-access`
  - 代理侧：`POST agent/session`、`heartbeat`、`claim`、`report`、`card-preflight`、`legacy-card-check/claim|report`
- PMS 表：`access_card_issue_batches`、`access_card_issue_items`、`access_card_agents`、`access_card_legacy_card_checks`、`access_card_authorizations`
- `.88` 表：`Employee` + `MJ_MacPower`（MjSystem）；`t_b_Consumer` + `t_b_IDCard` + `t_d_Privilege`（iCCard）
- `.80` 表：`HR.Person` + `MC.CardInfo`
- 缺口：
  1. beta 页额外楼栋入口丢失；`extraBuildingIds` 固定空数组。
  2. 发卡未写 PMS `access_cards`（`business` 模块只在「门禁卡购买/补卡」收费完成时插入 `AC<时间戳>` 假卡号，见 `business.service.ts` 的 `issueAccessCards`），导致 beta 页「在用门禁卡」显示的不是真实发卡结果。**这是真 bug，不是 UI 差异。**
  3. 工作站选择、能力门禁、可交付判定丢失。
  4. 数量上限 20 与设计文档 1–6 冲突，需产品确认。
- 验收：真实 ACR122U 写卡 + `.80` 入库 + `.88` 权限/控制器 + 现场刷卡，缺一不可。

### 2.2 延期 —— 未实现（无接口、无任务类型、无写库）

- 旧页面：❌ 旧发卡页也没有；设计文档未定义。
- beta：❌
- 目标表/字段：
  - `.88` MjSystem：`Employee.dBeginDate` / `Employee.dEndDate`（样例均为 `2000-01-01` ~ `2040-12-31`）
  - `.88` iCCard：`t_b_Consumer.f_BeginYMD` / `f_EndYMD`（样例 `946656000000`≈2000-01-01、`2240496000000`≈2040-12-31）；`t_b_IDCard.f_Deadline` 现行数据多为 NULL
  - `.80`：`MC.CardInfo` 20 个字段中**没有有效期字段**；捷顺 SDK 的 IC DTO 有 `StartDate/EndDate`（见 handoff §3.2），说明延期很可能要走 SDK 或别表，不能直接猜 SQL
- 缺口：无「延期」业务接口；无 Agent 任务；无到期时间校验/写后回读；无延期流水。**需现场确认 `.80` 延期是写库还是调 SDK/原软件接口。**

### 2.3 挂失 —— 未实现

- 旧页面：❌（设计文档明确「挂失、补卡、重发应走独立业务」）
- 目标：
  - `.88` iCCard：`t_b_IDCard.f_LostDate`、`f_CardStatusDesc`、`f_StatusChangeDate`；`f_CardStatusDesc` 现网样例为 `"0"`（正常），其他状态码**未取证**
  - `.88` MjSystem：`Employee`/`MJ_MacPower` **没有挂失字段**；原软件挂失行为需取证（可能删权限/改备注），不能猜
  - `.80`：捷顺 SDK 有 `Lost` 能力（handoff §3.2）；SQL 表字段语义未取证
- 缺口：无挂失接口/任务/写库；状态码与 MjSystem 语义未确认。

### 2.4 解挂 —— 未实现

- 同上；捷顺 SDK `UnLost`；iCCard 清 `f_LostDate`/状态回 `"0"`；MjSystem 无字段；无接口/任务。

### 2.5 注销（退卡）—— 未实现

- 旧页面：❌
- 目标：
  - `.88` iCCard：`t_b_IDCard.f_DeletedDate`、`f_CardStatusDesc`、`f_StatusChangeDate`；并删 `t_d_Privilege`
  - `.88` MjSystem：删 `MJ_MacPower` 后删 `Employee`（或反向），需与原软件退卡行为对齐
  - `.80`：SDK `Quit`；`MC.CardInfo.Status` 值语义未取证（现有 PMS 写入固定 `Status=1`）
- 缺口：无注销接口/任务/写库；「注销=删除记录还是置状态」未确认；已发卡历史不能删（审计要求）。

### 2.6 换卡 —— 未实现

- 旧页面：❌
- 需求本质：同一房号/住户换一张新物理卡，旧卡作废、新卡继承楼栋权限，`.80` 记录同步换卡关系。
- 现状：没有「旧卡→新卡」关联字段/流程；`AccessCardIssueItem` 只支持一次发卡任务；`.80` 无换卡接口。需要新业务表或复用批次+作废关系。
- 缺口：接口、状态机、审计、外部库联动全部缺失。

### 2.7 补卡 —— 未实现（仅收费侧有假卡号）

- 旧页面：❌
- 现状：`business` 模块有「门禁卡购买/补卡」收费项（`BusinessServiceType.ACCESS_CARD`），`issueAccessCards` 只生成 `AC<时间戳><序号>` 假卡号写 `access_cards`，与真实 IC/WG 卡号无关，也不触发发卡任务。
- 缺口：补卡应先收费/登记，再进入发卡任务；现在两条链路完全没打通。

### 2.8 读写卡 —— 已实现（读写器侧）

- 旧页面：✅ 完整（ACR122U、加密初始化卡识别、写镜像、逐块回读、错误卡拒绝、重复卡停止）
- beta：✅ 后端与代理能力保留；页面不展示读写器诊断细节
- 接口：`agents`（注册）、`readiness`、`claim/report`、`card-preflight`、`card-preflight` + `legacy-card-check`
- 代理文件：`CardReader.cs`、`CardProfiles.cs`（DPAPI `access-card-profiles.dat`）、`CardInitializerForm.cs`
- 缺口：beta 页无「设备检测/读卡查询」入口；无「读卡号查询该卡归属」入口（代理侧只服务发卡任务）。

### 2.9 批量导入 —— 未实现

- 旧页面：❌（旧页只有一次发 1–6 张；批量导入在业主/亲情车模块有先例）
- beta：❌
- 现状：`family-car` 有「从 `.80` 停车库批量导入」、`owners-mgmt` 有「业主档案批量导入」可复用模式（幂等键 `legacyRef`、逐行错误结果）。
- 缺口：门禁卡批量导入没有 CSV 模板、校验、幂等键、进度与失败明细；也没有和发卡任务/外部库的联动。

### 2.10 查询 —— 部分实现（仅按房号）

| 查询维度 | 现状 | 接口/数据源 |
|---|---|---|
| 按房号查历史卡 | ✅ 有 | `GET /houses/:houseId/context`（合并 PMS 发卡 + `.80` 历史 + `.88` 权限） |
| 按卡号查归属 | ⚠️ 仅发卡前置查重用 | 代理 `legacy-card-check`（`.80` `FindCard`） |
| 按姓名/电话/楼栋查询 | ❌ | 无接口；`.88`/`.80` 均未暴露搜索 |
| 在用卡清单 | ⚠️ beta 用 `/business/search` 的 `access_cards`，数据源是收费假卡号（见 2.1） | `business.service.ts` |
| 通行记录 | ❌ | `.88` 有 `t_d_CardRecord`（267,989 行）、`MJ_MacRecord`（67,912 行）、`MJ_MacANRecord`（215,233 行）但无接口 |
| 权限组/发卡方案 | ❌ | `.88` iCCard `t_b_Group`（50 行）、MjSystem `PowerHeader`（76 行）/`MJ_MacTime`；`.80` SDK `GetPermissionGroups` |
| 有效期/状态 | ❌ | 无展示；`.88`/`.80` 字段未接入 |

### 2.11 导出 —— 未实现

- 旧页面：❌（无导出按钮）
- beta：❌
- 缺口：无 CSV/Excel 导出接口，无列定义、无权限控制、无脱敏规则（卡号、姓名、手机号、房号）。

---

## 3. 两个外部库现状（路径 / 加密 / 访问方式 / 表 / 幂等）

### 3.1 .88 电脑：两套 Access MDB

| 项 | MjSystem | iCCard |
|---|---|---|
| 运行库路径 | `C:\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\MjSystem\Database\ChineseSimple\MJDataBase.mdb` | `C:\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\iCCard\iCCard.mdb` |
| 大小（2026-09-30 备份） | 25,030,656 B | 88,150,016 B |
| 是否加密 | **否**（Jet 无数据库密码） | **是**（Jet OLEDB:Database Password，DPAPI `iccard-db-password.dat` 只在 .88 本机） |
| 共享路径 | `\\192.168.1.88\c\...` 存在且可读（本机已 `Test-Path` 验证） | 同左 |
| 正确访问方式 | 设计文档要求 **.88 本机短事务写入**；共享目录只用于备份/只读调查，禁止跨机直接改 MDB | 同左 |
| PMS 代理配置 | `AgentConfig.MjSystemDatabasePath` | `AgentConfig.IcCardDatabasePath` + `--install-iccard-password` |
| 关键表（已核对 schema） | `Employee`(3209)、`MJ_MacPower`(10541)、`MJ_MacInfo`(20)、`MJ_DoorInfo`(20)、`MJ_MacRecord`(67912)、`MJ_MacANRecord`(215233)、`Log`(6934)、`PowerHeader`(76)、`MJ_MacTime`(3)、`LayerInfo`/`LayerDoorInfo` | `t_b_Consumer`(7300)、`t_b_IDCard`(7431)、`t_b_Group`(50)、`t_b_Door`(40)、`t_b_Controller`(23)、`t_d_Privilege`(11768)、`t_d_CardRecord`(267989)、`t_s_wglog`(11514) |
| 关联关系 | `Employee.vCardNo`=WG 卡号；`MJ_MacPower.cCardNo`=WG；门=`MJ_DoorInfo.cDoorId`；控制器=`MJ_MacInfo.cMacSn/vCom/vIP` | `t_b_Consumer.f_ConsumerID` ← `t_b_IDCard.f_ConsumerID`；`t_b_IDCard.f_CardNO`=WG；`t_d_Privilege.f_ConsumerID`+`f_DoorID`；门=`t_b_Door.f_DoorID`；控制器=`t_b_Controller` |
| 当前 Agent 已实现 | 只读探测（4 表计数）、`FindPermissions`、`Activate` 写入（Employee + MJ_MacPower）、`RemovePermissions`、控制器上传/撤销/远程开门（`AccessControllerUploader`） | 只读探测（3 表计数）、`FindPermissions`、`Activate` 写入（Consumer + IDCard + Privilege + 用户组校验）、`RemovePermissions`、控制器上传/撤销/远程开门 |
| 幂等/回滚 | 事务 + `EmpMemo = PMS_ITEM_<id>` / `PMS_AUTH_<taskId>` 标记；先查 WG 是否属于当前任务；逐栋隔离；写后回读 | 事务 + `f_Note = PMS_ITEM_* / PMS_AUTH_*`；用户组必须唯一匹配；写后回读 `f_GroupID/f_DoorID`；失败整事务回滚 |
| 缺口 | 无按卡/房号/楼栋/通行记录查询；无延期/挂失/注销；`accessDbWrite` 只凭探测成功就上报 true，未验证写权限 | 同左；另外**没有 MDB 密码就无法在非 .88 机器上做写测试** |

现场门映射（已核对）：MjSystem 门名有纯数字（`20` 表示 20 号楼，`M0003-1`）、`XX号单门控制器`；iCCard 门名 `XX号大门`，门 ID 1–40。楼栋路由分别由 `AccessGatewayDatabase.ExtractBuildingNo` 与 `access-card-routing.ts` 解析，不得在页面硬编码。

### 3.2 .80 电脑：捷顺 JSOCTNet SQL Server

| 项 | 现状 |
|---|---|
| 库类型/地址 | SQL Server（现场为 2008 时代实例），`192.168.1.80`，库名 `JS0131625`（`AgentConfig` 默认值；handoff §3.1 现场确认） |
| 账号 | 配置默认 `SA`（`agent.config.legacy-sync.example.json`）；密码只在本机 DPAPI `legacy-db-password.dat`，**本次开发机没有**，未连接验证 |
| 程序/共享 | `\\192.168.1.80\Program Files (x86)\G3\JSOCTNet`（只读调查路径） |
| 关键表 | `HR.Person`（`ID/NO/Name/...`）、`MC.CardInfo`（20 列：`ID,SID,IDNO,ICNO,Status,PersonSID,PersonID,Deposit,UserID,OptDate,IssueDate,IssueOptons,Remark,ServerNO,ServerDown,Ver,IsPlan,MediaType,PhysicalCardType,VMAutoQuitDeviceName`） |
| 已实现读 | `GetHistory`（按房号，宽松 SQL + 程序逐段核对弄/楼/室）、`GetRecentCards`（最新 30 笔 `MC.CardInfo`）、`FindCard`（全库 UID 查重，含孤立卡）、`FindAvailableIcNo`（ICNO 只读分配，起点 30500） |
| 已实现写 | `SyncIssuedCard`：`SERIALIZABLE` 事务 + `UPDLOCK/HOLDLOCK`；先按 UID/ICNO 回读幂等；`房号/序号` = `max(匹配数量, 最大尾号)+1`；插入 `HR.Person`（固定兼容默认值）+ `MC.CardInfo`（`Status=1`、`IssueOptons='010000...'`、`Remark='PMS大铁门授权'`）；提交前按 UID+ICNO+PersonID+Status 回读 |
| 缺口 | 无人员/卡按姓名、房号、卡号搜索；无权限组（SDK `GetPermissionGroups` 未接）；无通行记录（表名未知，需 `INFORMATION_SCHEMA` 只读发现）；无延期/挂失/解挂/注销写操作；账号权限与 DB 版本本机无法验证；`legacyDbWrite` 能力上报是按身份写死，未做真实写权限校验 |

### 3.3 本机已有的安全实验资产（不连生产库）

`D:\PMS-Access-Backups\`（2026-09-30 从 .88 共享目录复制，manifest 含 SHA-256）：

- `20260930-125356\MJDataBase.mdb` / `iCCard.mdb`：原始备份；`MJDataBase-write-test.mdb` / `iCCard-write-test.mdb`：写入实验副本。
- `mjsystem-schema.json`（83 表 / 列类型）、`iccard-schema.json`（约 100 表 / 列类型）、`mj-doors.json`、`ic-doors.json`、`mj26-samples.json`、`ic11-samples.json`：离线 schema 与真实样例，足以在不接触生产库的情况下开发/回归读写 SQL。
- 注意：`iCCard.mdb` 副本仍带 MDB 密码，写测试必须有密码或改在 .88 本机执行。

**凭据边界**：以上备份和 schema 均不含任何密码；DPAPI 密文不能跨机使用。禁止把密码写入源码、文档、日志、Git。

---

## 4. beta 页覆盖导致的回退清单（按影响排序）

1. **在用门禁卡数据源错误**：`/business/search` 返回的是收费模块 `access_cards` 的假卡号（`AC<时间戳>`），不是真实发卡结果；真发卡后此区块可能空/错。旧页用的是 `houseContext.history`。
2. **可交付判定丢失**：二期卡未确认控制器上传也会显示完成，存在把未生效卡交付给住户的风险。
3. **楼栋权限管理丢失**：无法给历史卡追加/撤销楼栋权限、无法单栋重试。
4. **历史卡补录丢失**：无法把 `.80` 历史卡「添加至门禁管理系统 / 下发至控制器」（旧页两个独立动作 + 两个最近 30 条列表）。
5. **远程开门丢失**：iCCard 检测/开门/临时常开、MjSystem 立即开门。
6. **设备与服务状态丢失**：只剩一个工作站在线 tag，无法判断 `.80`/`.88`/控制器/读卡器哪个环节不可用。
7. **代理注册入口丢失**：新电脑无法从页面注册代理、下载助手。
8. **模拟模式丢失**：无法在无硬件环境演示/回归完整流程。
9. **额外楼栋丢失**：二期只能发本楼栋权限。
10. **数量上限不一致**：20 vs 设计 1–6。
11. **发卡前置能力校验丢失**：工作站离线/路由未就绪也能建批次。
12. **历史来源与刷新丢失**：看不到 `.80`/`.88` 数据是否已回传，无法手动刷新。

---

## 5. 需要 Lead / 现场提供或确认的信息（缺一项都不能猜着连）

| # | 需要的信息 | 用途 | 获取方式（不泄露到 Git） |
|---|---|---|---|
| 1 | `.80` SQL Server 实际版本（`SELECT @@VERSION`）与实例端口 | 确认 TLS 兼容、驱动行为 | 现场 `.80` 执行 `--legacy-capabilities`（代理内置只读探测，会返回版本/库名/登录名/权限） |
| 2 | `.80` 数据库账号及权限：读需 `db_datareader` + `INFORMATION_SCHEMA`；写需 `HR.Person`/`MC.CardInfo` 的 INSERT/UPDATE | 避免用 SA、避免无权限写 | 现场在 `.80` 执行 `--install-db-password`；**不要把密码发聊天/文档** |
| 3 | `.80` 只读 schema 发现（**Lead 已批准**；优先只读账号，没有只读账号时用 SA 只跑 SELECT，不做 DDL/DML） | 找人员/卡/通行记录/权限组表 | 现场助手在线后执行 `--legacy-schema` / `--legacy-schema <表名>` |
| 4 | `.88` iCCard MDB 密码安装状态（`iccard-db-password.dat`）；**Lead 已确认由用户在现场安装** | 本地副本写测试、真库写入 | 现场 `.88` 执行 `--install-iccard-password`；本地测试用环境变量，不落盘 |
| 5 | `.88` 副本生命周期写测试（**Lead 已批准**：先用 `D:\PMS-Access-Backups` 本地副本，默认回滚，`-Keep` 才提交） | 降低生产风险 | 工具见 `tools/access-db-lab/TestAccessCardLifecycle.ps1`；写入带 `PMS_TEST_*`/PMS_ 标记并清理 |
| 6 | 延期/挂失/解挂/注销/换卡/补卡的**业务口径**：是否与原捷顺软件一致；`.80` 走 SQL 还是 SDK；`MC.CardInfo.Status`、iCCard `f_CardStatusDesc` 各状态码含义；MjSystem 挂失/注销到底改哪张表 | 写操作语义不能猜；Lead 已明确生命周期写默认关闭、接口先抛「语义未确认」 | 现场用可作废测试卡 + 原软件对照；提供状态码样本 |
| 7 | 补卡/换卡收费与发卡是否联动（是否先走 `business` 收费再发卡） | 定状态机 | 业务确认 |
| 8 | 批量导入的源文件格式（历史门禁卡清单/旧系统导出）与导入后是否写外部库 | 定 CSV 模板与幂等键 | 业务提供样表 |
| 9 | 导出的范围/列/权限/脱敏要求 | 定导出接口 | 业务/Lead |
| 10 | 验收窗口与可作废测试卡（至少 2 张 M1、可清空）、现场 MjSystem/iCCard 各一台控制器在线 | 端到端验收 | 现场安排 |
| 11 | Web 页归属：本次写作用域不含 `neighbor-web`，beta 页功能补齐需要另派 owner | 避免我越界改前端 | Lead 分配 |

---

## 6. 建议实施顺序（按可验证性）

1. **P0 差量文档 + 只读查询**（本次）：补 `.88` 按卡/房号/楼栋/通行记录查询、`.80` 人员/卡/通行记录 schema 发现；beta 页数据源修复（需 Web owner）。
2. **P1 能力如实上报**：`.80` 用只读权限/事务回滚探测 `legacyDbWrite`，`.88` 用文件可写 + 事务回滚验证 `accessDbWrite`/`controllerUpload`，不再按身份写死。
3. **P2 生命周期写**：延期 → 挂失/解挂 → 注销 → 换卡/补卡，每项先在副本上做「事务 + 标记 + 回读 + 清理」测试，再按现场状态码开放；每项都必须有 PMS 任务记录与幂等键。
4. **P3 批量导入/导出 + Web 页补齐**。
5. **P4 端到端验收**：实体卡写卡 → `.80` 入库 → `.88` 权限 → 控制器确认 → 现场刷卡；导出对账。

---

## 7. 本次交付与验证记录（2026-11-06）

### 7.1 改动范围

- 只改：`apps/api/src/modules/access-card-issuance/`、`tools/access-card-agent/`、`tools/access-db-lab/`、`docs/access-card-gap.md`。
- 不改：`apps/neighbor-web`（beta 页补齐需另派 owner）、`apps/api/src/entities`、迁移、收费/停车/账单模块。
- 不 commit / push / 发布；未连接生产库、未写生产 MDB、未写 `.80`。

### 7.2 Windows 代理（tools/access-card-agent）

新增/修改：

| 文件 | 内容 |
|---|---|
| `AccessDatabaseQuery.cs`（新增） | `.88` 只读查询：按卡号（含 7/8 位补零变体）、房号、姓名查人员/卡/状态/楼栋权限；最近 50 条通行记录（`MJ_MacRecord` + `t_d_CardRecord`）；用户组/时间组 |
| `AccessCardLifecycle.cs`（新增） | `.88` 生命周期写入：iCCard 延期/挂失/解挂/注销、MjSystem 延期/注销；默认关闭；状态码必须配置；事务 + 写后回读 + 幂等；MjSystem 挂失/解挂明确拒绝 |
| `AgentDatabaseCapabilities.cs`（新增） | 用「零行 UPDATE + 回滚」实测 MjSystem/iCCard 读写权限，不再按代理身份写死 `accessDbWrite` |
| `AccessOleDb.cs`（新增） | Jet 4.0 失败自动回退 ACE OLEDB 12.0（本机 Jet 注册不完整时也能读） |
| `LegacyDatabase.cs` | 新增 `.80` 只读能力探测（`@@VERSION/DB_NAME/SUSER_SNAME` + `HAS_PERMS_BY_NAME` + 行数）、人员/卡搜索、`INFORMATION_SCHEMA` schema 发现 |
| `AgentLoop.cs` | 心跳能力改为真实探测：`legacyDbWrite` 需 `.80` INSERT 权限；`accessDbWrite` 需 MDB 写权限；新增 `accessCardQuery`/`legacyCardQuery`；iCCard 缺密码不再导致整个心跳失败 |
| `Program.cs` | 新增 CLI：`--access-query`、`--access-records`、`--access-groups`、`--access-capabilities`、`--access-lifecycle`、`--legacy-search`、`--legacy-schema`、`--legacy-capabilities`、`--access-driver-test` |
| `AgentConfig.cs` + 示例配置 | `AccessLifecycleEnabled`（默认 false）、`AccessLostStatus`、`AccessCancelStatus`、`AccessNormalStatus` |

已验证（本机，复制 exe 到 `%TEMP%` 后运行，未连生产）：

```text
--access-capabilities
{"mjSystemReadable":true,"mjSystemWritable":true,"icCardReadable":false,...,"CanWrite":true}
（iCCard 失败原因：本机未安装 MDB 密码，符合预期）

--access-query 06234735
mjsystem / 06234735 / 228/26/602/9 / personNo 6890 / 26号楼权限 / endDate 2040-12-31

--access-query 228/26/602
返回该房 9 张历史卡，含 MJ_MacPower 的 26/20/9 号楼历史权限

--access-lifecycle extend 06234735 --date 2041-12-31   # 副本，-Keep
mjsystem completed, 2040-12-31 -> 2041-12-31
第二次同命令 -> skipped（幂等）

--access-lifecycle cancel 06234735 --allow-non-pms     # 副本，-Keep
mjsystem completed（删除 1 条权限 + 员工记录，回读 0）
第二次 -> skipped
```

`--self-test` 新增卡号补零变体、PMS 标记识别断言，已通过。

### 7.3 Access 实验工具（tools/access-db-lab）

新增 `README.md`、`QueryAccessCard.ps1`、`TestAccessCardLifecycle.ps1`；命令与实测输出见 README §3/§4。要点：

- 只读查询覆盖卡号/房号/姓名 + 权限 + 通行记录；房号查询按弄/楼/室逐段核对，不串户。
- 副本写测试默认事务回滚，`-Keep` 才提交；拒绝 `\\` 网络路径；iCCard 密码只从环境变量读取。
- 已验证：MjSystem 延期回滚后 `endDate` 仍为 2040-12-31；`-Keep` 延期/注销及幂等 skip 均符合预期。
- iCCard 分支在本机因缺少 MDB 密码返回 `failed`（预期），需 .88 现场安装密码后复跑。

### 7.4 API（apps/api/src/modules/access-card-issuance）

- 新增 `POST /api/v1/access-card-issuance/cards/lifecycle` 占位接口：校验权限/参数（操作类型、8 位 WG、幂等键）后返回 **501**，消息明确「.80/.88 写入语义尚未现场取证，不猜测」。覆盖延期/挂失/解挂/注销/换卡/补卡。
- `readiness.features` 新增真实能力：`accessCardQuery`、`legacyCardQuery`；`legacyDbWrite/accessDbWrite` 改为取代理实测结果。
- 验收：`pnpm --filter @pms/api typecheck` 通过；`pnpm --filter @pms/api test:access-card` **137 项全过**（0 fail）。

### 7.5 仍未完成（等凭据/语义/Web owner）

1. `.80` 生产只读 schema 发现（等现场装 `legacy-db-password.dat`，Lead 已批准只读）。
2. `.88` iCCard 副本写测试与真库写入（等现场 MDB 密码；状态码取证）。
3. 生命周期 API 从「501 占位」升级为真实任务队列 + Agent 执行（等语义确认；当前 Agent CLI 已具备副本验证过的执行代码）。
4. 批量导入/导出接口（等 CSV/列/脱敏口径）。
5. beta Web 页功能补齐（不在本任务写作用域，需另派 owner；本文档 §4 是它的验收清单）。

## 8. 门禁主板远程控制（2026-11-07，新后台后端）

### 8.1 接口

| 方法/路径 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/access-card-issuance/door/open` | `business:edit` | 入队开门/常开任务，返回 `taskId` |
| `GET /api/v1/access-card-issuance/door/task/:id` | `business:view` | 任务状态与控制器回执 |
| `GET /api/v1/access-card-issuance/door/controllers?communityId=` | `business:view` | 控制器/门板在线状态（按小区过滤） |
| `POST /api/v1/access-card-issuance/door/check-online` | `business:edit` | 触发 `controller_detect` 主动在线检查；每块 iCCard 控制器一条任务，MjSystem 跳过；agent 离线/版本 <2.5.46 直接 503；10 秒防抖；写审计 |

`POST /door/open` body：

```json
{
  "communityId": 228,
  "controllerId": 11,
  "doorNo": 11,
  "operation": "remote_open",
  "minutes": 5,
  "reason": "业主忘带卡，现场确认",
  "idempotencyKey": "door-open-20261107-0001"
}
```

- `controllerId` 当前就是 PMS 楼栋 ID（现场路由是「一栋楼 → 唯一实体门/控制器」）；`doorNo` 只做一致性校验，必须等于楼栋逻辑门号；将来支持一楼多门时再扩展。
- `remote_open` 不需要 `minutes`；`temporary_open` 必填 `minutes`，范围 **1–60**。
- MjSystem 暂不支持常开：返回 400「当前控制器不支持常开：MjSystem 仅开放立即远程开门」，不入队、不重试。
- 同一 `idempotencyKey` 返回原任务，不重复入队/审计。

任务状态映射：`pending`（已入队）、`sent`（网关已领取/发送中）、`succeeded`（控制器回执确认）、`failed`（明确失败）；同时返回 `rawStatus`、`controllerResults`、`receipt`（controller/door/protocol/acknowledgement）、`error`。

### 8.2 复用现有任务通道（没有另起一套）

- 复用表：`access_card_authorizations`（`operation` 直接用已有的 `remote_open` / `temporary_open` / `restore_normal`，`targetBuildings` 存楼栋，`durationSeconds` 存秒）。
- 复用领取/回报：`.88` 的 `access_gateway` 助手通过 `POST /access-card-agent/history-authorizations/claim` 领取，`POST /history-authorizations/report` 回报；`AgentLoop.HandleHistoryAuthorization` 已支持这四个门禁操作。
- 复用执行：`AccessControllerUploader.ExecuteDoorOperation`（iCCard `9D10` / `8F10`，MjSystem 原生 SDK `1A`）。
- 复用自动恢复：`temporary_open` 成功后服务端自动创建 `restore_normal` 任务（现有逻辑），按 `durationSeconds` 到点恢复。
- 权限沿用 `access-cards` 的 `business:view/edit`，不新增页面 key、不改权限迁移。

### 8.3 控制器在线状态（复用回执，不新建表）

没有单独硬件在线表；`GET /door/controllers` 聚合：

1. `access_gateway` 心跳 + `remoteDoorControl` 能力 + 助手版本 ≥ 2.5.46 → `agentOnline`；
2. 该楼栋最近一次 `controller_detect` / `remote_open` / `temporary_open` 的 `access_card_authorizations.controllerResults`（agent 上报的 controller/SN/时间）；
3. 推导 `status`：`online`（最近完成）、`offline`（最近失败或网关离线）、`pending`（执行中）、`unknown`（无回执）。

返回每栋：`controllerId`、`buildingNo`、`doorNo`、`doorName`、`controllerName`、`accessSystem`、`supportRemoteOpen`、`supportTemporaryOpen`（MjSystem=false）、`lastCheckedAt`、`lastError`。

**主动重新检查**：`POST /door/check-online` body `{communityId, controllerIds?}`。不传 controllerIds 时检查该小区全部可探测控制器；每块 iCCard 控制器创建一条 `controller_detect` 任务（现有 `ExecuteDoorOperation` 单目标限制），MjSystem 明确跳过并返回原因；agent 离线或版本 <2.5.46 返回 503 且不排队；同一控制器 10 秒内复用原任务（pending/running 无论多久都复用）；审计写 `business_logs.action='access_door_check_online'`。任务完成/失败后，`GET /door/controllers` 的 `status/lastCheckedAt/lastError` 自动反映，不需要额外落库。

### 8.4 审计

复用 `business_logs`（`transactionId = 门禁任务 ID`，`action = access_door_<operation>`）：
- 入队时记录：操作人、小区、控制器、楼栋、门号、操作、分钟数、原因、请求时间、`status=pending`；
- 控制器回报完成时回写：`status/result`、`controllerResults`、controller/door/acknowledgement、错误、时间。
- 看审计可用现成业务日志页面；不存卡号/密码等敏感信息。

### 8.5 本期边界（未做/待现场）

- 仅本地/测试验证命令构造与任务流转；**生产发送需 Lead 确认且现场有人守门**。
- 不支持一楼多门/指定物理控制器 SN；`controllerId=楼栋 ID` 是当前模型。
- 未做前端入口（`/access-cards`、`/devices`），Web owner 按本文接口契约接入。
- 临时常开恢复依赖 `.88` 网关在线；离线时任务保留、重连后执行（现有行为）。
- MjSystem 只开放 `remote_open`；检测/常开仍拒绝，等现场协议验收。
