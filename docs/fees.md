# 物业费（后台记账）

2026-08-27 上线。后台菜单：**收费业务 → 物业费**（pageKey `fees`，路由 `/fees`）。

## 范围：只做记账，不做支付

做的：按户出账单、登记收款、查欠费、维护每户收费标准、导入老系统历史账目。
**不做**：业主端在线缴费、微信支付商户号、滞纳金自动计算、对账、电子发票。
理由和边界见 [roadmap-phase2.md](./roadmap-phase2.md#物业费缴纳业主端在线缴费)——
要加支付请单独立项，不要在这一页上挂个「去支付」按钮就算完。

## 数据模型

两张表，都是 `TenantEntity`（`tenant_id` 行级隔离），并且都把 `community_id`
**冗余落库**，角色数据范围过滤才能走一条带索引的条件（沿用前台收费那套做法）。

### `fee_standards` —— 每户的收费标准
`community_id / house_id / fee_code / fee_name / amount_cents / standard_cents /
effective_from / effective_to / status / doc_no / remark / legacy_ref`

- **为什么按户而不是按小区单价**：老系统就是按户登记的（`wydj` 表），同一小区里
  商品房 / 售后公房 / 商铺 / 签报减免的标准都不一样。按小区存单价接不回存量数据。
- `amount_cents` 是每月实收，`standard_cents` 是签报调整前的原标准（没有减免时为 null）。
- 同一户同一项目只允许一条 `active`：新增标准时旧的自动转 `history` 并把
  `effective_to` 封到新标准生效前一日（`FeesService.createStandard` 里做，别绕过）。

### `fee_bills` —— 账单（一户 / 一个项目 / 一个账期一条）
`community_id / house_id / owner_id / owner_name / fee_code / fee_name / period /
amount_cents / status / paid_at / payment_method / receipt_no / invoice_no /
cashier / refunded_at / remark / source / standard_id / legacy_ref`

- `period` 是 `YYYYMM` 字符串，直接比大小就能筛区间，不用日期函数。
- `owner_name` 是**随单快照**：业主换了，历史账单上还是当年那个人。
- 状态机：`unpaid ⇄ paid`（登记收款 / 撤销收款）、`unpaid ⇄ cancelled`（作废 / 恢复）、
  `paid → refunded`。**作废的账单不计入应收和欠费**（免收、误生成用它，留痕不留账）。
- 已收款的账单不能改金额/账期、不能删除、不能直接作废，必须先「撤销收款」——
  否则「已收多少」和实际收到的钱对不上。

## 接口（`/api/v1/fees`，权限 key `fees`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fees/bills` | 账单列表，**服务端分页** `{rows,total,page,pageSize}` |
| GET | `/fees/bills/summary` | 当前筛选条件下的 应收 / 实收 / 欠费 合计 |
| GET | `/fees/arrears` | 欠费按户汇总（欠几笔、欠多少、欠费区间） |
| GET | `/fees/houses/:houseId` | 一户的全部账单 + 收费标准 |
| POST | `/fees/bills` · PATCH/DELETE `/fees/bills/:id` | 手工增改删 |
| POST | `/fees/bills/pay` · `/unpay` · `/cancel` · `/restore` | 批量收款 / 撤销 / 作废 / 恢复 |
| POST | `/fees/bills/generate` | 按当前生效标准，为某小区某账期铺一遍账单 |
| GET/POST | `/fees/standards` · PATCH/DELETE `/fees/standards/:id` | 收费标准 |
| POST | `/fees/import` | 老系统导入（收费标准 + 账单），按 `legacy_ref` 幂等 |

**这是全项目第一个服务端分页的列表接口**。别照抄其它页的 `.limit(5000)` +
前端翻页：账单是「户 × 月 × 项目」，一个小区十年就是几十万条，一次全取会把浏览器打死。

**收据号**：一次收几个月共用一个收据号，留空自动生成 `SJ<年月日><当天四位序号>`。

## 老系统导入

工具：[`tools/legacy-fee-import.mjs`](../tools/legacy-fee-import.mjs)（本机 MySQL → 线上 API）。

```bash
node tools/legacy-fee-import.mjs --tenant 1 --token <JWT> \
  --mysql-password <pwd> --offices 01,09,10
```

四步顺序执行：房产补齐 → 业主档案 → 收费标准 → 历史账单，后一步依赖前一步。
所有写入都带 `legacyRef`（`wjwy:zh:<ZH_ID>` / `wjwy:dj:<wydj.ID>` / `wjwy:zj:<ZJ_ID>`），
服务端按它 upsert，**中途失败直接重跑即可，不用先清库**。

房号匹配规则在 [`apps/api/src/common/house-index.ts`](../apps/api/src/common/house-index.ts)，
业主导入和物业费导入共用一份：先按「小区/弄/号/室」精确匹配，匹配不上时，
如果那栋楼下只有一户就按楼匹配（商铺在老库里「室」填的是门牌号，PMS 里填「商铺」）。
**匹配不上的行不猜**，原样退回给调用方写进未匹配清单。

导入时守的三条规矩（`OwnersMgmtService.importOwners`）：
1. 一户一个在册业主，房号被别人占着就不抢绑，退回 conflicts 让人工判断；
2. 手机号全公司唯一，号码已属于别人时这条不写 phone，号码转存 `contact_note`；
3. 认不出手机号的联系方式（固话、`13916151630袁`）一律进 `contact_note`，phone 留空。

### 已导入：枫桦景苑（2026-08-27）

老库 `吴泾物业` 管理处 01/09/10 → PMS 枫桦景苑一期 / 二期。

| | 数量 |
|---|---|
| 房产 | 1663 间（其中 16 间公配用房本次新建） |
| 业主档案 | 1655 条（手机号 1156、仅固话/备注 425、绑定房号 1654） |
| 收费标准 | 3380 条（当前生效 1648、历史 1732） |
| 历史账单 | 310731 条，账期 2004-07 ~ 2023-12 |
| 已缴 / 未缴 / 退款 | 297455 / 13274 / 2 |
| 欠费 | 1051 户、¥2,887,978.60（与老库逐项核对一致） |

**欠费口径要说清楚**：老系统在枫桦景苑的最后一笔收款是 **2022-10-31**，账单却预生成到
2022-12（个别到 2023-12）。所以这 288 万欠费是**老系统 2022 年 10 月的快照**，
不是「今天还欠这么多」。2022 年 11 月之后如果在别处收过款，需要在本系统补登记收款。

## 踩过的坑

- `mysql --batch` 的 NULL 打印成字面量 `NULL`（不是 `\N`）。不还原成 null，
  「弄」为空的商铺会变成 `lane='NULL'` 一条都匹配不上，退款日期也会被当成有值，
  310731 条账单全被判成「已退款」。
- 未缴账单上的 `HBDJHM` 是老系统的**通知单号**，不是收据号。摆在「收据号」列里
  收费员会以为这笔已经收过 —— 只有真收到钱才写 `receipt_no`，未缴的搬进备注。
- 电话不能用 AntD `Statistic` 渲染：纯数字串会被加千分位，`13916517940` 变成
  `13,916,517,940`，照着念都打不通。
- `date` 列走 `getRawMany` 会被 pg 驱动转成 JS Date，序列化成 UTC 后差一天
  （2019-01-01 显示成 2018-12-31）。列表里的日期列一律 `to_char(col,'YYYY-MM-DD')`。
- 导入接口一次几千行，Express 默认 100kb 的 JSON 上限会直接 413。
  `main.ts` 里用 `app.useBodyParser('json',{limit:'20mb'})` 抬到 20MB ——
  **不要 `import { json } from 'express'`**：express 只是 `@nestjs/platform-express`
  的传递依赖，`pnpm deploy --prod` 的产物里它不在顶层 node_modules，线上会
  `MODULE_NOT_FOUND` 起不来（2026-08-26 就这么把线上打挂过一次）。
