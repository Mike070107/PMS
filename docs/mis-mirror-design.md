# MIS 数据镜像 / 收款差异 / 断线收款设计（设计稿，未实现）

> 状态：设计待确认。本文只描述方案，不包含实现；Phase A 可独立先实施。
> 范围：MIS（一通物业，SQL Server 2008 R2，只读）→ PMS 本地库；MIS 三小区：枫桦景苑一期、枫桦景苑二期、上海新家。
> 原则：**不写 MIS、不建 MIS 触发器、不假设 CDC/变更数据捕获**；PMS 不直接改 MIS 账。

---

## 0. 调研事实（2026-11-08 生产只读实测）

### 0.1 MIS 侧数据量与更新

| 表/对象 | 行数 | 主键 | 增量字段 | 说明 |
|---|---:|---|---|---|
| `dbo.WYZJ`（应收/收费明细） | 650,920 | `ZJ_ID`（identity 1,1） | `updatedate`（smalldatetime，分钟级） | 已缴行 634,549；退款/红冲 311 行；近 30 天更新 4,184 行、近 7 天 1,427 行；近期每日 69–420 行 |
| `dbo.业主表` | 2,080 | `ZH_ID`（identity） | `updatedate`（smalldatetime，仅日期） | 近 30 天更新 6 行；姓名/移动电话/固定电话 |
| `dbo.室表` | 2,346 | `S_ID`（identity） | `updatedate`（smalldatetime） | 室号/房屋性质/面积 |
| `dbo.楼表` | 207 | `L_ID`（identity） | `updatedate`（smalldatetime） | 管理处/地址1-4/楼编号；管理处即小区映射 |
| `dbo.SETUPSFXM`（收费项目） | 16 | `ID`/`DH`（identity） | 无可靠更新时间 | 小表，每次全刷 |
| `dbo.收款方式列表` | 5 | `id`（identity） | 无可靠更新时间 | 现金/支付宝/微信/银联/转账，小表全刷 |

实测 `WYZJ`：

- `ZJ_ID` 是 identity，max = 654,544；可作新增行水位。
- `updatedate` 为 smalldatetime，有分钟（如 2026-11-07 15:34:00），可作更新水位；但历史退款样本存在 `updatedate = NULL`，只能靠首次全量覆盖。
- `SC` 在全部 650,920 行均为 NULL，**没有有效的软删/撤销标记**；`ZJ_TKRQ` 仅代表退款/红冲（311 行），不能代表删除。物理删除无法从增量发现 → 必须周期性全量对账。
- `ZJ_SKRQ` 是 smalldatetime，但已缴行的时分秒全部为 00:00:00：**MIS 收款日期只有日期精度**；`updatedate` 是记录更新时间，不是收款时刻。

### 0.2 MIS 查询延迟（生产 API 到 MIS，只读实测 SQL 中位数）

| 查询 | 延迟 |
|---|---:|
| 大屏 dashboard 聚合 | ~455ms |
| households 首页 | ~378ms |
| 待缴金额分档聚合 | ~199ms |
| options（收费项目） | ~11ms |

生产慢请求统计（近 24h）：`/fees/mis/residential` 301 次、avg 2130ms、max 4623ms；`/fees/mis/recent-payments` 86 次、avg 2454ms。慢主要在 MIS 连接/大查询，不是服务器 CPU/内存。

### 0.3 PMS 现有收款数据（为什么需要新表）

- PMS 当前物业费只读 MIS，没有 MIS 三小区的本地收款流水。
- `fee_bills` 是 PMS 自有收费（公寓/自营小区）的历史/收银台账，近 30 天真实收款只发生在 PMS 自营小区（馨香臣寓颛桥店、吴泾一村）；枫桦一期/二期最后 `paid_at` 停在 2022-10-31，上海新家无记录，不能当作 MIS 三小区收款来源。
- `business_transactions` 只有 6 行停车月租/门禁卡业务，不含物业费。
- 结论：MIS 三小区的本地收款需要**新表**，不能塞进 `fee_bills` 或 `business_transactions`；可与现有 cashier 共用收款方式字典/凭证号规则，但账务口径分开。

---

## 1. 目标与非目标

### 目标

1. MIS 每 **5 分钟**增量同步到 PMS 本地，支持本地查询；MIS 断线时查镜像，页面显示「数据截至 <同步时间>」。
2. 设置开关 `data_source_mode = mis | mirror`（默认 `mis`），一处切换。
3. MIS 断线时 PMS 能正常收款记账（本地收款流水），恢复后与 MIS 人工补录的收款做核销。
4. 生成「收款差异清单」：按天给出 `PMS 有 MIS 无`、`MIS 有 PMS 无`、`金额不一致` 三类，只读、可筛选、可导出。
5. 断线超过 30 分钟才向系统管理员推送一次微信；恢复后推一条恢复通知；大屏不显示离线告警，只显示数据截止时间。

### 非目标

- 不写 MIS、不建触发器、不依赖 CDC。
- 不做自动修改 MIS 或自动补账；差异清单只读，人工处理。
- 不把 PMS 收款自动回写 MIS。
- 本期不做跨系统双向实时对账；只做定时增量 + 恢复窗口对账。

---

## 2. 总体架构

```
MIS (SQL Server, 只读)
   │ 每 5 分钟增量轮询（只读账号，串行）
   ▼
PMS PostgreSQL
   ├─ sync_state                同步水位/健康状态
   ├─ mis_mirror_building/room/owner/fee_item/payment_method
   ├─ mis_mirror_bill           WYZJ 镜像（保留 ZJ_ID）
   ├─ pms_mis_receipts          PMS 本地收款（断线时）
   ├─ pms_mis_receipt_items     收款明细（可选，多费项）
   ├─ mis_reconciliation_*      核销批次/匹配
   ├─ mis_collection_differences 按天差异清单
   └─ TenantConfig.data_source_mode
```

读路径：

- `data_source_mode=mis`：现有直连 MIS（保持现状，不改变老行为）。
- `data_source_mode=mirror`：读本地镜像 + 本地收款；页面返回 `dataAsOf`（最近成功同步时间）。
- MIS 异常时：mirror 模式直接可用；mis 模式降级读镜像并明确标注「数据截至」；不回退到不确定的旧接口数据。

写路径（收款）：

- 正常：仍以 MIS 人工录入为准；PMS 不写 MIS。
- MIS 不可用 / `mirror` 模式：PMS 写本地 `pms_mis_receipts`（状态 `pending`），立即给收据/回执。
- MIS 恢复：定时对账任务把本地收款与镜像 MIS 已缴账单匹配，更新 `matched`/`difference`；不自动改 MIS。

---

## 3. 镜像表设计

所有镜像表统一带：

- MIS 原始主键（`source_*_id` 或直接用原名）
- `synced_at timestamptz`：最近一次成功写入时间
- `row_hash varchar(64)`：对业务字段做 SHA-256，用于跳过无变化行/对账
- `is_deleted boolean default false`：仅在全量对账发现源行消失时标记（增量无法可靠发现物理删除）
- 不复制 MIS 的二进制/大文本无用列；`备注` 只保留必要短文本

### 3.1 `mis_mirror_building`

```sql
CREATE TABLE mis_mirror_building (
  l_id bigint PRIMARY KEY,              -- 楼表.L_ID
  office_code varchar(16) NOT NULL,     -- 管理处（01/02/03/04）
  road varchar(60),                     -- 地址1
  lane varchar(30),                     -- 地址2
  building_no varchar(30),              -- 地址3
  address_extra varchar(120),           -- 地址4等
  building_code varchar(30),            -- 楼编号
  source_updated_at timestamptz,
  row_hash varchar(64) NOT NULL,
  synced_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_mis_mirror_building_office ON mis_mirror_building(office_code, lane, building_no);
```

### 3.2 `mis_mirror_room`

```sql
CREATE TABLE mis_mirror_room (
  s_id bigint PRIMARY KEY,              -- 室表.S_ID
  l_id bigint NOT NULL,
  room_no varchar(30) NOT NULL,         -- 室表.室
  nature varchar(20),                   -- 房屋性质
  area_sqm numeric(10,2),
  source_updated_at timestamptz,
  row_hash varchar(64) NOT NULL,
  synced_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_mis_mirror_room_building ON mis_mirror_room(l_id);
```

### 3.3 `mis_mirror_owner`

```sql
CREATE TABLE mis_mirror_owner (
  zh_id bigint PRIMARY KEY,             -- 业主表.ZH_ID
  s_id bigint NOT NULL,
  name varchar(60),
  mobile varchar(30),
  phone2 varchar(30),
  contact varchar(120),
  source_updated_at timestamptz,
  row_hash varchar(64) NOT NULL,
  synced_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_mis_mirror_owner_room ON mis_mirror_owner(s_id);
```

### 3.4 `mis_mirror_fee_item` / `mis_mirror_payment_method`

```sql
CREATE TABLE mis_mirror_fee_item (
  fee_code varchar(20) PRIMARY KEY,     -- SETUPSFXM.DH
  fee_name varchar(100) NOT NULL,
  synced_at timestamptz NOT NULL
);
CREATE TABLE mis_mirror_payment_method (
  method_id int PRIMARY KEY,            -- 收款方式列表.id
  method_name varchar(50) NOT NULL,
  synced_at timestamptz NOT NULL
);
```

### 3.5 `mis_mirror_bill`（WYZJ）

```sql
CREATE TABLE mis_mirror_bill (
  zj_id bigint PRIMARY KEY,             -- WYZJ.ZJ_ID（identity）
  zh_id bigint,
  s_id bigint,
  l_id bigint,
  office_code varchar(16),
  fee_code varchar(20),                 -- ZJ_LX
  period varchar(6),                    -- ZJ_CNY
  amount_cents bigint NOT NULL,         -- ZJ_JE 元→分
  paid_date date,                       -- ZJ_SKRQ（仅日期）
  refund_date date,                     -- ZJ_TKRQ
  payment_method varchar(30),           -- WYZJ.收款方式
  cashier varchar(60),                  -- 收款人
  source_updated_at timestamptz,        -- updatedate
  source_sc varchar(10),                -- SC（当前全 NULL，保留）
  row_hash varchar(64) NOT NULL,
  synced_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_mis_mirror_bill_house_date ON mis_mirror_bill(office_code, s_id, paid_date);
CREATE INDEX idx_mis_mirror_bill_updated ON mis_mirror_bill(source_updated_at, zj_id);
CREATE INDEX idx_mis_mirror_bill_owner ON mis_mirror_bill(zh_id);
```

说明：`amount_cents` 用 BIGINT 存分；MIS money 转换为分时照现有 `misMoneyToCents` 规则四舍五入，保留原始字符串到 `source_amount_text`（建议加列，便于对账追溯）。

### 3.6 `sync_state`

```sql
CREATE TABLE mis_sync_state (
  id serial PRIMARY KEY,
  tenant_id int NOT NULL,
  source_table varchar(40) NOT NULL,       -- building/room/owner/bill/fee_item/payment_method
  high_water_updated_at timestamptz,
  high_water_id bigint,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error varchar(300),
  consecutive_failures int NOT NULL DEFAULT 0,
  full_sync_at timestamptz,
  UNIQUE(tenant_id, source_table)
);
```

`mis_sync_health` 可只放在 `sync_state` 聚合视图，不另建表。

---

## 4. 同步机制（5 分钟）

### 4.1 调度

- NestJS 定时任务每 **5 分钟**（`@Cron('0 */5 * * * *')`）执行；启动时若镜像为空先做全量。
- 全局串行锁：`pg_advisory_lock(hashtext('mis-mirror-sync'))` 或 `sync_state` 行锁；同一时间只能一个同步任务。
- 每次同步顺序：小表（fee_item/payment_method）→ building/room/owner → WYZJ。失败即记录，下一轮重试，不并行写。
- 任务超时/进程崩溃后由下一轮从水位继续；upsert 幂等。

### 4.2 增量水位

- **WYZJ（主表）**：用 `(updatedate, ZJ_ID)` 双水位：
  - 每轮从 `sync_state` 取 `high_water_updated_at - 5min` 作为重叠窗口（防边界漏行）；
  - `WHERE updatedate >= @since OR (updatedate = @since AND ZJ_ID > @lastId)`；
  - 按 `ZJ_ID` upsert，`row_hash` 相同跳过；
  - 取本轮 `MAX(updatedate), MAX(ZJ_ID)` 推进水位；`updatedate IS NULL` 只在全量路径处理。
- **业主表**：`updatedate` 只有日期精度，使用 `updatedate >= 当前日期 - 1 天` 的日重叠窗口；数据量小，也可每轮全表（2,080 行）。
- **室表/楼表**：`updatedate` 存在但精度日；行数 2,346/207，**每轮全表 upsert**（几毫秒级），避免漏变更。
- **收费项目/收款方式**：16/5 行，每轮全表。
- **删除**：MIS 无有效删除标记（SC 全 NULL）；增量不能发现物理删除。全量对账（建议每日 03:00）：
  - 拉取当前源 ID 集合与镜像 ID 集合做差；
  - 镜像有、源无 → `is_deleted=true`（同时保留历史供审计，不物理删）；
  - 源有、镜像无 → 补插；
  - `row_hash` 变化 → upsert；差异写日志。
- **退款/红冲**：`ZJ_TKRQ` 或负数 `ZJ_JE` 通过同一行 upsert 反映；不单独建退款表。

### 4.3 全量重灌路径

- 运维接口/命令行（需管理员）：`POST /fees/mis/mirror/reload`（设计，不在本期实现）或脚本 `pnpm --filter @pms/api mirror:reload`。
- 使用 staging 表（`mis_mirror_*_staging`）+ 单事务 `TRUNCATE`/`INSERT ... SELECT` 后 `ALTER TABLE ... RENAME`，或按主键批量 upsert；对 WYZJ 650k 行分批 2,000 行。
- 完成后重置 `sync_state` 水位、`full_sync_at`，再恢复 5 分钟增量；失败不影响旧镜像（staging 可丢弃）。
- 首次全量预计：WYZJ 650k 行 + 小表约 2.5k 行；按每批 2,000 行/3–5 秒估算，约 3–8 分钟（需 Phase B 实测，避开营业高峰）。

### 4.4 延迟目标

- 正常增量同步延迟目标：**≤ 5 分钟 + 单轮耗时（目标 <30 秒）**。
- 断线恢复后：≤ 5 分钟发现 + 一轮同步 + 对账任务（目标 <5 分钟）；大屏只显示数据截止时间。

---

## 5. PMS 本地收款（断线收款）

### 5.1 表结构

```sql
CREATE TABLE pms_mis_receipts (
  id bigserial PRIMARY KEY,
  tenant_id int NOT NULL,
  receipt_no varchar(40) NOT NULL,          -- 本地凭证号，唯一
  house_key varchar(80) NOT NULL,           -- 与 MIS 一致的 office:S_ID:ZH_ID（能映射时）
  community_id int,
  office_code varchar(16) NOT NULL,
  s_id bigint,
  zh_id bigint,
  address_snapshot varchar(255) NOT NULL,
  owner_name_snapshot varchar(60),
  amount_cents bigint NOT NULL,
  payment_method varchar(30),               -- 复用 cashier 字典：cash/wechat/alipay/...
  paid_at timestamptz NOT NULL,             -- 实际收款时间（可到秒）
  operator_id int,
  operator_name varchar(60),
  status varchar(16) NOT NULL DEFAULT 'pending', -- pending/matched/difference/void
  idempotency_key varchar(120) NOT NULL,    -- 防重复提交
  note varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, receipt_no),
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX idx_pms_mis_receipts_day ON pms_mis_receipts(tenant_id, (paid_at AT TIME ZONE 'Asia/Shanghai')::date);
CREATE INDEX idx_pms_mis_receipts_house_day ON pms_mis_receipts(tenant_id, office_code, s_id, (paid_at AT TIME ZONE 'Asia/Shanghai')::date);
```

多费项收款可另建 `pms_mis_receipt_items(receipt_id, fee_code, period, amount_cents)`；本期若只按总额收款，可先不建，差异按总额匹配。

### 5.2 与现有 cashier / fee_bills 的关系

- `fee_bills` 和公寓收费台继续服务 PMS 自营小区，不动、不复用为 MIS 三小区收款。
- 新表 `pms_mis_receipts` 只存 MIS 三小区断线期间的物业费收款；可复用 `fee_bills` 的收款方式枚举、凭证号规则、操作人展示；
- 未来若 PMS 接管更多收费，可把 `pms_mis_receipts` 的接口抽象成统一 “本地收款”，但不迁移旧 `fee_bills`，避免影响历史报表。
- 收款成功后返回本地收据；大屏/今日实收把 `pms_mis_receipts` 的 pending/matched 状态纳入计算（见第 6 节防重）。

### 5.3 防重复提交

- 服务端生成 `receipt_no`；客户端可用 `Idempotency-Key`（或由前端生成）映射 `idempotency_key`，重复请求返回同一收据。
- 数据库唯一约束 `(tenant_id, receipt_no)` / `(tenant_id, idempotency_key)`；不靠前端按钮防抖。

---

## 6. 核销与匹配（恢复后）

### 6.1 匹配键

- 房号：`office_code + s_id`（MIS `管理处 + 室表.S_ID`）；无 S_ID 时用 `office_code + lane + building_no + room_no`。
- 金额：`pms_mis_receipts.amount_cents` 与 MIS 同房同日已缴账单合计 **精确到分**。
- 日期：北京时间 `paid_date`（MIS 只有日期；PMS `paid_at` 转北京时间日期）。
- 可选辅助：收款方式；不强制（MIS 收款方式可能为空）。
- 一房同日多笔：先按房号+日期聚合两边的总额；完全相等即匹配，不等进入差异。

### 6.2 匹配结果

| 条件 | 结果 |
|---|---|
| PMS 与 MIS 均有，金额相等 | `matched`，记录关联 MIS `zj_id` 列表；不产生差异 |
| PMS 有、MIS 无 | 差异类型 `pms_only`（怀疑漏录） |
| MIS 有、PMS 无 | 差异类型 `mis_only`（人工在 MIS 操作，PMS 未核销） |
| 两边均有但金额不同 | 差异类型 `amount_mismatch` |
| 同房同日多笔金额相同但无法唯一对应 | 按本地收据创建时间顺序与 MIS `updatedate` 排序做确定性匹配；仍有歧义则 `ambiguous` 入差异待人工核销 |

### 6.3 核销表

```sql
CREATE TABLE mis_reconciliation_matches (
  id bigserial PRIMARY KEY,
  tenant_id int NOT NULL,
  receipt_id bigint NOT NULL,
  mis_group_key varchar(120) NOT NULL,   -- office:sid:date
  mis_zj_ids bigint[] NOT NULL,
  matched_amount_cents bigint NOT NULL,
  status varchar(16) NOT NULL,           -- matched/ambiguous
  matched_at timestamptz NOT NULL,
  matched_by int,                        -- null=系统对账任务
  UNIQUE(tenant_id, receipt_id, mis_group_key)
);
```

差异清单可实时从核销结果生成，也建议落快照表（见 6.5）以便审计和导出。

### 6.4 对账回填任务

触发：
- MIS 从不可用恢复（sync health 从 failed → success）；
- 每日 03:30 全量对账；
- 手动「立即对账」（管理员）。

流程：
1. 确定窗口：断线期间从 `last_success_at` 开始，或最近 7 天 + 未核销 receipts；
2. 从镜像取窗口内 MIS 已缴账单，按 `office_code+s_id+paid_date` 聚合；
3. 取 `pms_mis_receipts` 同窗口 pending，聚合；
4. 按 6.1/6.2 比对，写 `mis_reconciliation_matches`，更新 receipt `status=matched/difference`；
5. 生成/更新差异快照（只读，不改 MIS/PMS 收款金额）；
6. 全部在一个事务/幂等批次内，重复运行不重复匹配（unique key）。

### 6.5 差异清单表

```sql
CREATE TABLE mis_collection_differences (
  id bigserial PRIMARY KEY,
  tenant_id int NOT NULL,
  diff_date date NOT NULL,                  -- 北京时间收款日
  community_id int,
  office_code varchar(16),
  s_id bigint,
  house_key varchar(80),
  address varchar(255),
  owner_name varchar(60),
  diff_type varchar(20) NOT NULL,           -- pms_only/mis_only/amount_mismatch
  pms_amount_cents bigint,
  pms_paid_at timestamptz,
  pms_operator varchar(60),
  mis_amount_cents bigint,
  mis_paid_date date,
  mis_channel varchar(30),
  mis_zj_ids bigint[],
  status varchar(16) NOT NULL DEFAULT 'open', -- open/resolved/ignored
  generated_at timestamptz NOT NULL,
  resolution_note varchar(255),
  UNIQUE(tenant_id, diff_date, office_code, s_id, diff_type)
);
```

只读生成，不自动改任何一方账。

---

## 7. 防重复统计

### 7.1 今日实收 / 大屏合并口径

- 读镜像的 MIS 已缴：按 `mis_mirror_bill` 的 paid 口径；本地 `pms_mis_receipts` 只有 **pending** 才额外计入（MIS 尚未有对应）。
- 状态 `matched` 的本地收据**不再计入**（MIS 行已计入一次）。
- `status=difference` 的本地收据：按「待人工核销」单独展示，不进入已实收合计，避免两边都算。
- 计算时用 receipt ↔ match 关联，禁止用「PMS 收款 + MIS 全量」简单相加。

### 7.2 页面提示

- 首页/大屏在 mirror 模式显示「数据截至 HH:mm」（最近成功同步时间）；不显示 MIS 离线告警。
- 断线期间本地收款在收据上标「本地记账 · 待核销」；恢复后自动核销，超过窗口仍未匹配进入差异清单。

---

## 8. 断线告警策略

- 健康判定：最近一次 5 分钟同步失败/超时，或 MIS 探测失败；连续失败 ≥ 30 分钟才告警。
- 告警对象：拥有 `logs:view` 的系统管理员（沿用现有 notifications 收件人解析）。
- 告警方式：微信订阅消息（复用现有通知服务/模板），只在首次超过 30 分钟发一条；`eventKey='mis_offline'`，fingerprint `mis-offline:<tenantId>`，恢复前不重复。
- 恢复：同步成功后发一条「MIS 已恢复，数据截至 HH:mm」（`eventKey='mis_recovered'`），并清除离线状态；恢复后可立即跑对账回填。
- 大屏不展示离线告警；仅在页面角落显示「数据截至 <last_success_at>」。
- 系统日志：`system_logs` category=alert，记录 `mis_offline`/`mis_recovered`、失败原因、最后成功时间，管理员可查。

### 8.1 Phase A 可先实现

不依赖镜像：
- 大屏前端刷新间隔 90s → **300s（5 分钟）**；
- 大屏显示「数据截至 HH:mm」（取各查询 `queriedAt`/最近成功响应时间）；
- 后端基于 MIS 查询健康（失败率/连续失败）实现 30 分钟阈值告警与恢复通知；
- 无需镜像表、无需改收款流程。

---

## 9. 设置开关

`TenantConfig` key：

```json
{ "key": "data_source_mode", "value": { "mode": "mis" } }
```

- `mis`（默认）：保持现有直连 MIS；断线时按 Phase A 显示数据截止；不自动切 mirror。
- `mirror`：读镜像 + 本地收款；同步任务持续运行；MIS 断线不影响读；页面显示数据截至。
- 切换只影响读路径，不改变写路径；切换需管理员确认，记录审计。
- 前端设置页一处切换：系统设置 → 数据源（MIS / 本地镜像）。
- `tenant.enabled_pages`/权限不变。

---

## 10. 收款差异清单页面

### 10.1 页面位置建议

**收费办理 →「账单与待缴」页面新增「收款差异」页签**（路由 `/bills?tab=differences`），权限沿用 `bills:view`。

理由：
- 差异是本日收费/对账运营动作，放在收费办理下最接近日常入口；
- 不新增页面 key/权限/迁移，避免重演 bills/intranet「菜单有、权限注册表漏」的问题；
- 如后续要独立菜单，再登记 `reconciliation` key 并迁移权限（不建议本期做）。

### 10.2 页面能力

- 筛选：日期区间（默认本月）、小区；
- 列：日期、房号、业主、PMS 金额/收款时间/操作人、MIS 金额/收款日期/渠道、差异类型、状态；
- 只读；操作仅有「导出 CSV」「标记已处理」（标记需要 `bills:edit`，不修改 PMS/MIS 金额）；
- 分页服务端查询，导出走独立 CSV 接口（复用现有 CSV 转义）。
- 差异类型文案：`PMS有MIS无`、`MIS有PMS无`、`金额不一致`。

### 10.3 CSV

导出接口建议：`GET /fees/mis/collections/differences/export?from&to&communityId`（权限 `bills:view`），UTF-8 BOM，字段顺序与页面一致；只读。

---

## 11. 监控项

| 指标 | 说明 |
|---|---|
| 最近同步成功时间 | `sync_state.last_success_at`，大屏/设置页展示 |
| 同步失败次数/连续失败 | 失败要写 system_logs；超过 3 次告警管理员 |
| 各表镜像落后条数 | 源行数 vs 镜像行数（全量对账时） |
| 增量本轮行数/耗时 | 每轮日志；异常大增量排查 |
| 未核销本地收据数 | `pms_mis_receipts status=pending` |
| 差异清单未处理数 | `mis_collection_differences status=open` |
| MIS 离线状态 | 最后成功时间、离线分钟数、告警已发标记 |

日志全部落 system_logs，管理员在日志页可见。

---

## 12. 实施分期

- **Phase A（可立即做，不依赖镜像）**：大屏 300s 刷新；数据截止 HH:mm；MIS 离线 30 分钟微信告警（一次）+ 恢复通知；大屏不显示离线告警。
- **Phase B（镜像基础）**：镜像表 + sync_state + 5 分钟增量 + 全量重灌 + 小表全刷 + 每日全量对账；设置开关 `mis|mirror`；本地查询/降级读。
- **Phase C（断线收款 + 核销）**：`pms_mis_receipts`（+items）；断线收款写本地；恢复后对账回填；差异清单生成；防重复统计。
- **Phase D（差异页/导出/运营）**：`/bills?tab=differences` 只读页、CSV、标记已处理、监控和告警完善。

每期独立可回滚；Phase B 前先备份、跑全量耗时测试。

---

## 13. 风险与待确认

1. MIS 无删除标记且物理删除不可见：全量对账只能按周期发现；删除保留镜像历史，需确认业务是否接受。
2. MIS 只有日期精度：差异匹配按日总额，无法区分同日多次收款的精确时间；PMS 本地时间仅用于排序/展示。
3. 业主/房号变更：`s_id` 稳定优先；若 MIS 重建房号，历史镜像需按 house_key 快照保留，不能重算历史。
4. PMS 本地收款与 MIS 人工录入可能重复/漏录：差异清单只读，人工核实后手工处理；不自动写 MIS。
5. `mirror` 模式首次上线前需要全量同步和延迟验证；未完成前默认 `mis`。
6. 大屏不显示离线告警属产品要求；日志/管理员仍可收到微信告警。
