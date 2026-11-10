# 统计汇总 P2–P4 报表列定义与口径（旧「一通」逐张对齐）

> 状态：**现状审计 + 历史设计/实测证据**（2026-11-10 本地源码复核；不是「全部待实现」，也不是「30 张已完成」）
> 原始设计：2026-11-09 夜；本次审计以当前工作区源码、历史验收和本地部署标签为依据
> 范围：旧「统计汇总」30 项逐项对照；当前 17 个可选报表、18 条待接入标签；剩余工作见 §3 与文末附录 E，最近复核见附录 F
> 数据身份：原文 SQL/金额是 **2026-11-09 历史生产只读结果**，旧菜单是 2026-11-06 本机快照；本轮不连接生产/MIS，不复测这些数字，不宣称当前线上可用
> 金额：**一律整数分（cents）**，文中「元」仅用于人工核对，换算 = 分 ÷ 100
> 边界：原独立审计仅修改[本报表文档](<docs/statistics-p2-report-layouts.md>)，未提交或发布；后续 Lead 的实现、验证与提交身份单独记录。历史原始设计保留，但与当前审计冲突时以 §0.4、§3、附录 E/F 为准；本文不构成生产发布授权。

---

## 0. 结论摘要

> §0.1–0.3 保留原始设计时点的发现，不是当前待办清单：票据/开票/签报/减免镜像及多张报表此后已实现；P2-B 已修正主要收款接口的退款/调整分块。年度 P1.3 已历史验收，不再等待 A/B 二选一。当前覆盖见 §0.4、§3。

### 0.1 覆盖与结论（2026-11-09 原始设计快照）

| P2 报表 | 旧菜单 | 结论 | 阻塞点 |
|---|---|---|---|
| 收费汇总 | 10 | ✅ 已可做（WYZJ 收款/退款/调整三块） | 「其他收费 WYZQ/WYSZ」源库为空，可不做 |
| 收款汇总表 | 7 | ⚠️ 部分可做（收款侧金额/方式/收款人/管理处） | 「收入(不含税)/税额/票据编号」缺镜像 |
| 收款日报表 | 6 | ✅ 已可做 | 列模板需截图确认（收款方式 vs 收费项目分块） |
| 月报表 | 25 | ⚠️ 可做但模板要改（旧「收费月报表」≠ 月×费项矩阵） | 28 列财务指标需截图；记账/调整日期未镜像（影响小） |
| 综合月报表B | 8 | ⚠️ 部分可做（核心 12 列可算，33 列模板待定） | 列头/统计维度需截图 |
| 综合月报表C | —（快照无此项） | ⏸ 待确认定义，不实现 | 推测为「营改增版」→ 需收入/税额镜像 |
| 分等综合月报表 | 15 | ❌ 不可做（源库无分等数据，旧系统同样报错） | 缺数据 + 缺镜像 |
| 收款分析 | 5 | ✅ 已可做（按户 历年欠/当年欠/当月应收/预缴） | 列名与基准需截图 |
| 日常收费项目收款日报表 | 14 | ✅ 当前费项矩阵入口已实现、未发布；旧模板未核验 | 退款/调整分列，所有金额下钻，见 §4.9 |
| 欠收与溢收汇总 | 9 | ✅ 已可做（欠收 + 预收两页签） | 精确复刻需补记账/调整/变动日期字段 |
| 收缴考核 | 30 | ✅ 已可做（行=房屋/管理处，月应收/收款 + 收缴率） | 收缴率分母、已收归属口径需截图 |

### 0.2 关键发现（会影响已上线/在制实现）

1. **退款语义（最重要）**：旧库 `WYZJ.ZJ_TKRQ` 是**给原收款行打退款标记**，279/280 行退款行金额为正、**没有**独立负数退款行；负数行是「负收款/调整（1,316 行，-¥676,202.90）」和「应收冲减（8 行未缴，-¥3,168.00）」，**不是退款**。仅 2026-10-19 有 1 组「原收款 + 负数行」成对退款（各 ¥150）。
   - 现有 P2-A `collection.service.ts` 把 `refund_date IS NOT NULL OR amount_cents < 0` 一律当退款、按 `ABS(amount)` 计退款额 → 对成对退款会**双计**（该组会算成退款 ¥300），且把负调整错标为退款。本文 §2.2 给出修正口径。
   - **历史 A/B 差异，不是当前 P1 待办**：原收款日期流水与剔除退款净额的全库历史差异为 ¥38,724.20；这不证明年度表算错。P1.3 后来已按所属年度 `period` 汇总已缴带符号流水验收（§0.4），原「收款年度、待截图统一净额」判断失效。
2. **旧「月报表」不是「月 × 收费项目」矩阵**：旧系统 `收费月报表` 是「行=小区（项目）/管理处，列=28 列财务指标（本期应收组 5 列、本期实收数组 5 列、预收转入/余额、累计实收、本期回收率、累计回收率、本期欠收、账面累计实收、累计溢收、收欠费、当月欠收）」。P2-A 在制的 `/statistics/monthly`（行=1–12 月，列=收费项目）**模板不对**，需改名或改造。
3. **收费汇总有 3 个块**：收款块（按收款日期）、退款块（按退款日期）、其他收费块（`WYZQ/WYSZ`，本库为空）。分组维度是 **收费项目 × 房屋性质**，筛选含「管理处/房屋性质/收费项目/收款方式」多选 + 收款人单选 + 日期区间 + 所属年度区间。
4. **收款汇总表以「票据开票数据」为主数据源**（`SUM(票据开票数据.金额) JE` 与 `收入(不含税) = 金额 - 税额`），并 UNION 无票据的 WYZJ 收款与车位收款；PMS 未镜像票据表 → 只能先做「收款侧金额」近似版。
5. **分等综合月报表在这套库上根本出不了数**：旧系统要求 `室表.分等收费标准` / `WYDJ.分等标准` / `分等收费标准明细`，而 2026-11-06 MIS 全库快照里：室表 2,346 行「分等收费标准」全空、WYDJ 7,037 行「分等标准」全空、`分等收费标准明细` 0 行。旧系统会直接提示「不是分等收费项目或没有设置分等收费标准」。建议 P2 不做，等用户确认。
6. **欠收/溢收/综合月报表的日期口径比 `paid_date` 复杂**：旧 SQL 还用了 `ZJ_Jzrq`（记账日期）、`ZJ_TZRQ`（调整日期）、`ZJ_Bdrq`（变动日期）三列，镜像未同步（源库非空仅 31/33/10 行，影响很小），但要 100% 复刻需补镜像列。

### 0.3 建议顺序（详见 §5）

先统一退款/实收口径（前置）→ 收费汇总 → 收款日报表/日常收费项目收款日报表（共用矩阵组件）→ 收款汇总表（近似版）→ 欠收与溢收汇总 → 收缴考核 → 收款分析 → 月报表（改造）→ 综合月报表B；分等综合月报表/综合月报表C 挂起。

---

### 0.4 当前源码与验收身份（2026-11-10 本地审计）

- 请求中所称 `REPORT_TYPES`，在当前源码实际对应 `StatisticsReportType` 与 `REPORTS`；全量目录为 [statistics.ts](<apps/neighbor-web/src/lib/statistics.ts#L387-L417>)，页面按类型分发 API，见 [Statistics 页面](<apps/neighbor-web/src/pages/Statistics.tsx#L475-L560>)。**17 个入口不等于旧 30 项一一完成**，其中包含额外「票据情况统计」，也包含未发布入口、核心指标/共用报表近似覆盖。
- 当前 17 类型：`received`、`arrears`、`fee-nature`、`daily`、`daily-fees`、`arrears-prepaid`、`assessment`、`collection-analysis`、`monthly-report`、`property-summary`、`owner-ledger`、`building-ledger`、`relief`、`signoffs`、`ticket-summary`、`ticket-items`、`tickets`。
- `PENDING_REPORTS` 当前 18 个显示标签：原 7 项，加销账、物业收款、收退款明细、三项能耗、收费标准与四项专用欠/溢报表，共补齐 11 项身份。B/C 合并成一个标签；住户票据查询、票据使用数量统计、线上收费查询不在旧统计菜单 30 项中。18 个标签是 15 项旧菜单待接入身份加 3 项额外需求，不是 18 张已实现报表；月报标签与现有核心指标版也不能重复计作完成。
- **P1 保持已验收口径**：实收按 `period` 所属年度分列，取 `paid_date IS NOT NULL` 的带符号金额（含退款标记正数与负调整），默认 13 类性质全选含 06，实收不按 `asOfPeriod` 截断；欠费默认不含 06。不把年度实收改成 P2 的净额，也不再重做 P1。历史 2026-11-10 00:30 验收：API `api-556ecdc` / Web `2.0.20261110-0029`，总计 ¥153,042,878.16；01×2004 ¥882.40 /23 行，01 欠费 ¥662,269.00。依据 [P1.3 验收](<docs/statistics-reports-spec.md#L192-L206>)及[当前年度聚合](<apps/api/src/modules/statistics/statistics.service.ts#L403-L425>)，不是本轮公网复验。
- 镜像已支持账单行级性质/收入/票据关联字段、费项 `category`，以及票据、开票行、票据核销记录、签报、减免；见[账单字段](<apps/api/src/modules/fees/mis-mirror.service.ts#L193-L257>)、[费项类别](<apps/api/src/modules/fees/mis-mirror.service.ts#L265-L279>)和[补充镜像](<apps/api/src/modules/fees/mis-mirror.service.ts#L298-L410>)。不能再笼统写「票据/收入/税额/类别均未镜像」；这也不等于所有旧源表和报表字段均齐全。
- 当前 `monthly-report` 是**管理处×11 项核心指标**，仍返回 `pendingColumns`；不是旧 28 列月报、33 列综合 B/C。未完成列由[月报待确认常量](<apps/api/src/modules/statistics/analysis.util.ts#L14-L24>)明确列出。旧 `/statistics/monthly`（月×费项）仍保留，并且仍标注 P2-A 旧净额逻辑，见[旧月报接口](<apps/api/src/modules/statistics/collection.service.ts#L419-L467>)；不能宣称全服务退款语义已经统一。
- **已合入、未发布**：开票统计 API `e93c9998` + 前端 `b69a911b`（附录 D）；日报新入口/分类下钻 `f68669af`（§4.9）。[交接新增记录](<docs/session-handoff-2026-11-09.md#L52-L69>)载 API 88/88、浏览器先 16/16 后 18/18、本地构建通过；均为历史本地/合成夹具证据，不是生产数据验收，本轮未重跑。
- 本地 Git 标签仍为 `deployed/web=665a99e8`（历史 Web `2.0.20261110-1025`）、`deployed/api=475b21f6`（历史 API `api-475b21f`）；上述三个功能提交均在相应标签之后。版本来自[历史交接](<docs/session-handoff-2026-11-09.md#L35-L41>)与本地 Git，不代表目前公网状态；后续发布/复验仍需当次明确授权。

---

## 1. 数据底座（2026-11-09 历史生产只读实测；非当前水位）

### 1.1 镜像表与水位

执行方式见附录 A。核心表：

| 表 | 行数（实测） | 关键列 | 备注 |
|---|---:|---|---|
| `mis_mirror_bill`（WYZJ 收费明细镜像） | 648,041 | zj_id、office_code、s_id、zh_id、address、owner_name、room_no、fee_code/fee_name、period(YYYYMM)、amount_cents、paid_date、refund_date、payment_method、cashier、nature_code、source_updated_at、synced_at | 主键仅 `zj_id`，无其它索引（全表聚合约 110ms，见附录 A） |
| `mis_mirror_room` | 2,346 | s_id、l_id、room_no、nature、area_sqm | **无「分等收费标准」「房型」「车位面积」列** |
| `mis_mirror_building` | 207 | l_id、office_code、road、lane、building_no | 楼栋 |
| `mis_mirror_owner` | 2,080 | zh_id、s_id、name、mobile、phone2 | 业主 |
| `mis_mirror_fee_item` | 16 | fee_code、fee_name | 收费项目字典 |
| `mis_mirror_payment_method` | 5 | method_id、method_name | 现金/支付宝/微信/银联支付/转账 |
| `mis_sync_state` | — | last_success_at、synced_rows、last_error | bill 最近成功 **2026-11-09 23:15:00 +08（15:15Z）** |

收费明细总体（2026-11-09 实测）：

```
rows=648,041 | 未缴=14,095 | 已缴=633,946 | 退款标记=280 | 负金额=1,325
period 200407–202808 | paid_date 2004-07-14–2026-11-09 | Σamount_cents=15,880,780,986（¥158,807,809.86）
已缴行合计（含退款标记/负调整）=15,480,577,066（¥154,805,770.66）
未缴净额=400,203,920（¥4,002,039.20）= 正数未缴 400,520,720（14,087 行）- 未缴负数 316,800（8 行）
```

按管理处（已缴行净额）：

| office_code | 旧名称 | 已缴行数 | 退款标记行 | 已缴合计（分） | 元 |
|---|---|---:|---:|---:|---:|
| 01 | 枫桦景苑一期 | 179,648 | 87 | 2,422,052,516 | ¥24,220,525.16 |
| 02 | 枫桦景苑二期A | 177,756 | 99 | 2,862,219,390 | ¥28,622,193.90 |
| 03 | 枫桦景苑二期B | 198,197 | 94 | 3,496,212,360 | ¥34,962,123.60 |
| 04 | 上海新家 | 78,345 | 0 | 6,700,092,800 | ¥67,000,928.00 |
| 05 | 馨香北桥-二期 | 0 | 0 | 0 | 无收费流水 |

收费项目（镜像字典 16 项，**流水实际只出现 7 项**）：

| fee_code | fee_name | 行数 | 已缴行数 | 已缴合计（分） |
|---|---|---:|---:|---:|
| 01 | 管理费 | 389,318 | 377,366 | 6,440,338,616 |
| 02 | 租金 | 60,756 | 60,073 | 6,488,517,800 |
| 04 | 泊位费 | 166,438 | 165,121 | 2,354,300,500 |
| 05 | 临时停车费 | 3,609 | 3,550 | 7,082,000 |
| 14 | 停车管理费 | 27,725 | 27,644 | 187,458,150 |
| 15 | 空房租金 | 3 | 0 | 0（全部未缴） |
| 16 | 置业泊位费 | 192 | 192 | 2,880,000 |

> 03/06/07/08/09/10/11/12/13 在本库无任何流水。旧报表列模板可能固定显示 16 项（无流水的补 0）或只显示有数据的费项，需截图确认。

收款方式（已缴行）：

| 收款方式 | 行数 | 金额（分） | 元 |
|---|---:|---:|---:|
| 现金 | 583,506 | 14,314,176,396 | ¥143,141,763.96 |
| 微信 | 35,614 | 668,080,550 | ¥6,680,805.50 |
| 支付宝 | 13,310 | 455,435,590 | ¥4,554,355.90 |
| 转账 | 1,492 | 42,146,530 | ¥421,465.30 |
| 银联支付 | 23 | 723,000 | ¥7,230.00 |
| （空） | 1 | 15,000 | ¥150.00（zj_id=440090，03 管理处，2022-06-03，陈  静） |

收款人（已缴行，前 10）：

| 收款人 | 行数 | 金额（分） | 备注 |
|---|---:|---:|---|
| 管理员 | 490,789 | 12,153,452,196 | **占 77.4%**，系统/批量导入占位，不是真实收款人 |
| 胡美君 | 75,129 | 1,306,083,660 | |
| 刘微微 | 34,018 | 590,815,900 | |
| 伍庆中 | 19,082 | 324,116,210 | |
| 赵丽萍 | 7,208 | 809,236,300 | |
| （空） | 3,987 | 74,957,930 | |
| 陈玉龙 | 1,844 | 38,442,170 | |
| 曹洁蓉 | 1,730 | 174,774,400 | |
| 陈  静 | 81 | 2,907,700 | |
| 傅文昌 | 78 | 5,790,600 | |

> 2026-10 只有 3 个收款人有流水（赵丽萍/刘微微/伍庆中），「收款人」维度报表在历史区间会高度集中在「管理员」，需与用户确认旧系统是否同样显示。

房屋性质（`bill.nature_code`，收费时点性质；已缴行）：

| nature_code | 名称 | 行数 | 金额（分） | 元 |
|---|---|---:|---:|---:|
| （空） | — | 12,614 | 176,289,250 | ¥1,762,892.50 |
| 01 | 商品房 | 601,440 | 14,579,153,680 | ¥145,791,536.80 |
| 02 | 售后公房 | 1 | 15,000 | ¥150.00 |
| 04 | 商铺 | 17,943 | 563,536,536 | ¥5,635,365.36 |
| 05 | 配套用房 | 31 | 435,000 | ¥4,350.00 |
| 06 | 空房 | 677 | 7,728,400 | ¥77,284.00 |
| 07 | 居住 | 136 | 18,289,200 | ¥182,892.00 |
| 08 | 非居住 | 1,104 | 135,130,000 | ¥1,351,300.00 |

> **房屋性质必须用行级 `mis_mirror_bill.nature_code`（收费时点），不是 `mis_mirror_room.nature`**（P1.1 已确认，spec §6/§8）。室表当前性质分布：01=1,975、04=74、05=15、06=10、07=263、08=8、空=1。
> 注意：泊位费/临时停车费大量行 `nature_code` 为空（2026-10 管理处 02 泊位费 ¥31,050.00 全部在「空」性质下），**按房屋性质筛选会把大部分车位类收费排除**，这是源库口径，需与旧系统截图核对是否同样如此。

### 1.2 数据质量与边界

- `paid_date` 只有日期精度（源库 smalldatetime 时分秒恒为 0），本文件所有日期区间用 **[from, to) 半开区间**。
- `period` 全为 6 位 YYYYMM（0 行非法）；`fee_code` 无空值；`amount_cents` 整数分（-¥676,202.90 的负调整来自「已发生负收款」）。
- 未缴负数 8 行合计 -¥3,168.00（应收冲减，如退盘/改账），统计「欠费」时是否冲抵需确认；P1 欠费口径为 `Σ amount_cents`（含负未缴行）。
- 15「空房租金」3 行全部未缴（¥7,500.00），属 06 空房性质。
- 管理处 05（馨香北桥-二期）在 PMS 无同名小区，且本库无流水；报表中 05 行显示 0，不做假数据。
- 旧库「其他收费」表 `WYZQ/WYSZ` 在 2026-11-06 快照中 0 行 → 收费汇总的「其他收费」块本库恒为 0。

### 1.3 旧系统定义证据来源（只读，不连 MIS）

- 本机旧客户端目录 `D:\一通MIS\`（VB6 客户端 + Crystal Reports 运行时），`物业管理.exe`（19MB）中包含全部报表窗体的标题、列头、筛选按钮和 **VB6 源码里的 SQL 字符串**；本文用 UTF-16LE 字符串检索提取（附录 B 给出 offset 索引）。
- 旧库菜单结构来自 2026-11-06 MIS 全库本地快照 `outputs/mis-db-sync-20261106/`（1,143 张表 CSV，只读、未入库、未提交 git），其中 `dbo.ApplicationModule` 给出「统计汇总」菜单 30 个子项的准确名称与 id。
- **未连接 MIS、未写任何表、未改源码**。

---

## 2. 统一口径与陷阱（实现前必须先定）

### 2.1 一行账单的 5 种类别（实测分类 SQL 与结果）

```sql
SELECT CASE
         WHEN refund_date IS NOT NULL AND amount_cents > 0 THEN 'R1 退款-原收款行(红冲)'
         WHEN refund_date IS NOT NULL AND amount_cents < 0 THEN 'R1b 退款-成对负数行'
         WHEN amount_cents < 0 AND paid_date IS NULL THEN 'R2 应收冲减(未缴)'
         WHEN amount_cents < 0 THEN 'R3 负收款/调整(已发生)'
         WHEN paid_date IS NULL THEN 'R4 欠费'
         ELSE 'R5 正常收款'
       END AS row_kind,
       COUNT(*) AS rows, COALESCE(SUM(amount_cents),0) AS sum_cents
FROM mis_mirror_bill GROUP BY 1 ORDER BY 1;
```

实测（2026-11-09）：

| 类别 | 行数 | 金额（分） | 语义 |
|---|---:|---:|---|
| R1 退款-原收款行(红冲) | 279 | 3,887,420 | 当年收过、后来退款；金额**正数**，靠 `refund_date` 标记 |
| R1b 退款-成对负数行 | 1 | -15,000 | 2026-10-19 唯一一组「原收款 + 负数行」退款（各 ¥150） |
| R2 应收冲减(未缴) | 8 | -316,800 | 减少应收（退盘/改账），未发生现金 |
| R3 负收款/调整(已发生) | 1,316 | -67,620,290 | 真实负现金流（退租退费/租金调整），**不是退款** |
| R4 欠费 | 14,087 | 400,520,720 | 未缴正数 |
| R5 正常收款 | 632,350 | 15,544,324,936 | |

### 2.2 实收口径必须逐报表声明（历史 A/B 对比；不得覆盖 P1.3）

> **审计校正**：下表是当时按收款日期比较 A/B 的历史计算，不是当前 P1 年度口径。原「必须二选一并全站统一」「年度实收默认 B」建议作废：年度 P1.3 已按所属年度、带符号已缴流水验收，见 §0.4。P2 分块为正收款/退款/负调整，净额按各块口径计算；开票统计又按开票日期，不能只因都含「实收」便跨报表强行统一。

| 口径 | 公式 | 全库 | 2026 年 | 适用 |
|---|---|---:|---:|---|
| A 收款流水（历史收款日期比较，非当前 P1 归年） | `Σ amount_cents WHERE paid_date IN 区间`（含 R1 正数、R3 负数） | 15,480,577,066 分 | 929,950,200 分 | 收款日报/收款汇总/收银员业绩 |
| B 有效净额（剔除退款标记） | `Σ amount_cents WHERE paid_date IN 区间 AND refund_date IS NULL`（= R5+R3，剔除 R1/R1b） | 15,476,704,646 分 | 929,950,200 分（年度合计与 A 相同，见下） | 当时备选口径；非当前 P1 实收验收定义 |

- 2026 年全年 A=B=929,950,200 分；逐月看只有 8 月（A 比 B 多 15,000 分）和 9 月（A 比 B 少 15,000 分）有差异，即那组成对退款的时点差（实测 Q19）。历史年度差异为 R1 行按其原收款年度的金额（合计 3,872,420 分 = ¥38,724.20）。
- **原 P2 统一建议已废止**：按每张报表的已确认定义执行；P1 例外已验收。当前主要 P2 收款接口分别算正收款、按退款日期的正数退款、按收款日期的带符号负调整；不能将负调整再当退款，也不能用一套年度净额替换所有报表。
- 与旧系统核对时，截图上的「本期实收数」到底等于 A 还是 B，是每张报表的必问项（单月最多差 ¥150，历史年份差更大）。

**修正后的退款/调整/净额 SQL 片段**（建议替换 P2-A `collection.service.ts` 的 `REFUND_ROW_SQL`；以下为口径片段，对应数值已用完整聚合 SQL 在 §4.1/§4.10 实测，验收断言见 §6 A1/A16）：

```sql
-- 收款流水（含后来退款的收款）
SUM(amount_cents) FILTER (WHERE paid_date >= :from AND paid_date < :to AND amount_cents > 0 AND refund_date IS NULL)
-- 退款（按退款日期；只计原收款正行，成对负数行不重复计）
SUM(ABS(amount_cents)) FILTER (WHERE refund_date >= :from AND refund_date < :to AND amount_cents > 0)
-- 负调整（真实负现金流）
SUM(amount_cents) FILTER (WHERE paid_date >= :from AND paid_date < :to AND refund_date IS NULL AND amount_cents < 0)
-- 有效净额
SUM(amount_cents) FILTER (WHERE paid_date >= :from AND paid_date < :to AND refund_date IS NULL)
```

### 2.3 其它统一约定

1. **管理处**：01 枫桦景苑一期、02 枫桦景苑二期A、03 枫桦景苑二期B、04 上海新家、05 馨香北桥-二期（05 无流水）。按 PMS 小区权限收敛（P1 `resolveStatisticsOffices`）。
2. **房屋性质**：`TRIM(bill.nature_code)` 行级性质，空值不算任何性质；不要用 `room.nature`。
3. **所属年月 vs 收款日期**：
   - 「应收/欠收/预收」→ `period`；
   - P2「收款/退款」→ `paid_date` / `refund_date`；**P1 年度实收仍按 `period` 归年**，开票统计按 `issue_date`；
   - 同一张报表内混用必须写清每列基准（旧系统表格本身就是混用的，见 §4 各张）。
4. **金额/格式**：整数分；显示 `¥x,xxx.xx`；CSV 用纯数字两位小数（复用 `lib/statistics.ts` 的 `fmtCents`/`annualCsv`）。
5. **数据范围/权限**：复用 `business:view` + 管理处→PMS 小区映射；05 仅全公司账号可见。
6. **缺数据不伪造 0**：镜像不可用返回 `available:false`+`message`；缺字段的列标「缺镜像」而不是填 0。

---

## 3. 旧「统计汇总」菜单全量盘点（30 项）

来源：[旧菜单 CSV](<outputs/mis-db-sync-20261106/data/0020_dbo.ApplicationModule.csv>)，父项 id=179，按 `SuperiorModuleID=统计汇总` 复核共 30 项。当前实现以 [REPORTS/PENDING_REPORTS](<apps/neighbor-web/src/lib/statistics.ts#L387-L417>)、[页面请求分支](<apps/neighbor-web/src/pages/Statistics.tsx#L475-L560>)与[统计路由](<apps/api/src/modules/statistics/statistics.controller.ts>)交叉核对；「有实现」仅指源码有正式入口/API，历史上线/本地未发布另列，不代表逐张旧模板验收。

| # | 旧菜单（完整 30 项） | 当前对应 / 覆盖等级 | 真实剩余或阻塞 |
|---:|---|---|---|
| 1 | 房产汇总 | `property-summary`；已有入口/API | 原 P3「未实现」过期；旧列/打印模板仍须逐张验收 |
| 2 | 住户台帐 | `owner-ledger`；已有入口/API | 当前为业主台账；租赁户及旧列不能默认等价 |
| 3 | 楼室台帐 | `building-ledger`；现名「楼房台账」 | 已有楼栋台账；楼/室两级旧模板差异待核对 |
| 4 | 应收帐销账情况 | **无专用入口/API，已列待接入灰字** | 销账/核销业务定义及源表关联待确认；票据核销不等于应收销账 |
| 5 | 收款分析 | `collection-analysis`；按户 LNQ/DNQ/DY/YJ 已有 | 租赁户 `ZL_ID` 未覆盖；旧列/筛选待确认；抽屉回归由 frontendGPT 负责 |
| 6 | 收款日报表 | `daily`；当前日期×费项矩阵已有 | 旧方式分组/打印列未验；新增退款调整日/分类下钻仍未发布 |
| 7 | 收款汇总表 | `ticket-summary`；收款块 + 独立开票块已有 | 非「未镜像」；旧票据∪无票WYZJ∪车位的完整并集/去重及模板仍未证明 |
| 8 | 综合月报表B | `PENDING_REPORTS` 的 B/C 标签 | **33 列财务模板未实现**；核心月报不能代替；需截图/列公式及维度证据 |
| 9 | 欠收与溢收汇总 | `arrears-prepaid`；汇总/户明细/逐笔已有 | 精确旧条件尚缺记账/调整/变动日期；抽屉回归由 frontendGPT 负责 |
| 10 | 收费汇总 | `fee-nature`；费项×性质及收退调整分块已有 | WYZQ/WYSZ 在历史快照为空，不表示永久无需；模板/年度范围仍需证据 |
| 11 | 物业收款汇总 | **无独立入口，已列待接入灰字** | 与 #7 的差别、管理处/项目维度和并集来源先确认，不能直接宣告复用完成 |
| 12 | 收退款明细统计 | 有共享逐笔 API/既有 MIS 流水能力；**无该统计入口，已列待接入灰字** | 附录 G 找到「退款情况统计」同窗体列头与退款日期条件，但菜单到窗体映射未证实；不可直接用当前四类流水替代 |
| 13 | 空房情况统计 | 待接入标签 | 缺出租/空置状态等镜像与定义；性质 06 不能替代实时空置状态 |
| 14 | 日常收费项目收款日报表 | `daily-fees`；已合入、**未发布** | 当前复用 #6，不自动筛「日常收费」；旧类别范围/列头未验（§4.9） |
| 15 | 分等综合月报表 | 待接入标签 | 历史源库室表/WYDJ 分等字段全空、标准明细 0 行；源数据 + 镜像 + 模板阻塞，不能写假数 |
| 16 | 项目实收年度汇总 | `received`；**P1.3 已历史验收** | `period` 归年、含带符号已缴流水；不再等待 A/B，不重做；目录 hint 在审计期间由并行工作修正（未验证发布） |
| 17 | 项目欠费年度汇总 | `arrears`；**P1.1/P1.3 已历史验收** | 行级性质排除 06 后 01 差异已解决；年度多选/权限/金额一致性由 backendGPT 复核 |
| 18 | 签报情况统计 | `signoffs`；已有镜像/入口/API | 原「未镜像」过期；流转过程及旧模板是否同范围仍待核对 |
| 19 | 能耗环比分析图表 | **无入口/API，已列待接入灰字** | 缺能耗抄表镜像及表具/期间/单位定义 |
| 20 | 能耗同比分析图表 | **无入口/API，已列待接入灰字** | 同 #19，不能用收费金额替代耗量 |
| 21 | 能耗分析统计图表 | **无入口/API，已列待接入灰字** | 同 #19，三项应分别保留待办，不因共用镜像就算三项完成 |
| 22 | 开票数据统计 | `ticket-items`；API/前端已合入、**未发布** | 源全部开票行口径，非有效净开票/收款；附录 D 本地验证不等于旧模板/生产验收 |
| 23 | 减免情况统计 | `relief`；已有镜像/入口/API | 原「未镜像」过期；旧签报关系/时间范围及模板待逐张验收 |
| 24 | 收费标准汇总 | **无入口/API，已列待接入灰字** | 附录 H/I 已证实 Histroy=0、费项×业主 SUM(JE)、费项格式化后相加的小计与网格回读页脚；四位 WYDJ 原始镜像/手工重灌基础已实现但未部署。单位、临界舍入/日期运行时显示、完整菜单调度及名称/地址源仍有缺口，API/模板未完成 |
| 25 | 月报表 | `monthly-report` 仅 **11 核心指标近似版**；完整模板仍待接入 | 旧 28 列未完成，`pendingColumns` 显式保留；旧 `/monthly` 月×费项也不是它 |
| 26 | 项目欠费统计 | `arrears-prepaid` 欠收明细能力复用 | 无独立旧菜单入口，明细/筛选等价尚未逐项验收 |
| 27 | 项目欠费汇总统计 | `arrears-prepaid` 欠收汇总能力复用 | 无独立旧菜单入口；旧分组/列/日期边界待核对 |
| 28 | 项目溢收统计 | `arrears-prepaid` 预收明细能力复用 | 目前「未来期已缴」不自动等同所有旧溢收口径；需旧截图/定义 |
| 29 | 项目溢收汇总统计 | `arrears-prepaid` 预收汇总能力复用 | 同 #28；无独立入口，不能宣告四项逐张完成 |
| 30 | 收缴考核 | `assessment`；12 月应收/收款、金额/户数指标已有 | 原「待实现」过期；旧表分母/收款归属/打印模板仍待确认 |

**边界补充**：综合月报表 C、住户票据查询、票据使用数量统计、线上收费查询均不在这 30 项中；C 与 B 在灰字中合并。当前额外可选 `tickets`「票据情况统计」不等于上述三张全部实现。住户检索/逐票开票明细已有复用能力，是否单列旧入口仍需用户确认；使用数量还需核对领用/库存/核销来源，线上收费缺独立数据源/权限/口径定义。

---

## 4. P2 逐张报表定义

> 说明：每节「实测」SQL 均于 **2026-11-09** 在生产 PMS 只读 `psql` 执行（`docker exec pms-postgres psql -U pms -d pms_repair`），输出为实际返回；「旧系统定义」来自 `物业管理.exe` 字符串（附录 B）。

### 4.1 收费汇总（菜单 #10）

**结论**：✅ 已可做（WYZJ 收款块 + 退款块 + 负调整）；⚠️「其他收费」源库为空；列模板待截图。

**旧系统定义（EXE offset 993400）**

- 表单：`收费汇总`；打印含「日期」区间、「收款方式：」「收款人：」「交款人签章 / 收款人签章」「总计」，纸张宽度不足时提示改横向。
- 收款块 SQL（原文）：
  ```sql
  Select Sum(WYZJ.ZJ_JE) AS JE, WYZJ.ZJ_LX, Count(WYZJ.ZJ_ID) AS ZS, WYZJ.FWXZ_DH
  From ((楼表 INNER JOIN 室表 ON 楼表.L_ID = 室表.L_ID)
        INNER JOIN 业主表 ON 室表.S_ID = 业主表.S_ID)
       INNER JOIN WYZJ ON 业主表.ZH_ID = WYZJ.ZH_ID
  Where (((WYZJ.ZJ_SKRQ) Between '起' AND '止'))
    AND (ZJ_SKRQ) Is Not Null
    AND Left(ZJ_CNY,4)>='年下限' AND Left(ZJ_CNY,4)<'年上限'
    And 管理处='xx'
    And 收款方式 In (...)
    AND 收款人='xx'
  GROUP BY WYZJ.ZJ_LX, WYZJ.FWXZ_DH;
  ```
- 退款块：同一 SQL 把 `ZJ_SKRQ` 换成 **`ZJ_TKRQ`**（按退款日期、按收费项目×房屋性质）。
- 其他收费块：`WYZQ/WYSZ` 按 `QC_LX × FWXZ_DH`（本库两表 0 行）。
- 筛选提示：「请勾选管理处！/请勾选房屋性质！/请勾选收费项目！/请勾选收款方式！」，收款人单选；另有「状态：」。

**数据源与关键字段**：`mis_mirror_bill`（office_code、fee_code、nature_code、amount_cents、paid_date、refund_date、payment_method、cashier、period）+ `mis_mirror_fee_item`（fee_name）。

**口径公式（主推）**

```
行：收费项目 fee_code × 房屋性质 nature_code（两层；旧系统 GROUP BY 两者）
块：收款块  = Σ amount_cents WHERE paid_date ∈ [起,止) AND refund_date IS NULL AND amount_cents > 0
    退款块  = Σ ABS(amount_cents) WHERE refund_date ∈ [起,止) AND amount_cents > 0
    调整块  = Σ amount_cents WHERE paid_date ∈ [起,止) AND refund_date IS NULL AND amount_cents < 0
     净额    = 收款块 + 调整块（= Σ amount WHERE paid_date∈区间 AND refund_date IS NULL）
               ※ 退款块只作信息列，不从净额扣减：退款的原收款多在往期收款块中，再扣会重复（生产验收 02/2026-10 net=15,314,220）
笔数：收款块 COUNT(*)、退款块 COUNT(*)（需截图确认笔数是否含负调整）
筛选额外：所属年度 = substr(period,1,4) ∈ [年下限, 年上限]
```

**行列/小计/排序**：行按 `fee_code` 升序、同费项内按 `nature_code` 升序；列 = 收款金额/笔数、退款金额/笔数（旧系统可能分两块打印）；底部「总计」= 各块合计；金额列右对齐、千分位两位小数。

**下钻**：总/单元格 → 逐笔明细（复用 P1 `/statistics/annual/detail/bills` 的逐笔形态 + P2-A `/statistics/collection/detail` 的日期区间筛选）；明细列：管理处、地址、业主、收费项目、所属年月、金额、收款日期、退款日期、收款方式、收款人。

**筛选**：管理处✓、房屋性质✓、收费项目✓、收款方式✓、收款人（单选/下拉）、收款日期起止、所属年度起止。

**实测（2026-11-09，管理处 02，2026-10-01~2026-10-31）**

```sql
SELECT b.fee_code AS fee,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01' AND b.refund_date IS NULL AND b.amount_cents > 0), 0) AS recv_flow_cents,
       COALESCE(SUM(ABS(b.amount_cents)) FILTER (WHERE b.refund_date >= '2026-10-01' AND b.refund_date < '2026-11-01' AND b.amount_cents > 0), 0) AS refund_cents,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01' AND b.refund_date IS NULL AND b.amount_cents < 0), 0) AS adjust_cents,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01' AND b.refund_date IS NULL), 0) AS net_effective_cents
FROM mis_mirror_bill b LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code
WHERE b.office_code = '02'
GROUP BY b.fee_code ORDER BY b.fee_code;
```

实测输出（02 管理处，2026-10，分 / 元）：

| fee | 项目 | 收款块 | 退款块 | 调整块 | 净额（分） | 净额（元） |
|---|---|---:|---:|---:|---:|---:|
| 01 | 管理费 | 11,915,220 | 0 | 0 | 11,915,220 | ¥119,152.20 |
| 04 | 泊位费 | 3,105,000 | 15,000 | -60,000 | 3,045,000 | ¥30,450.00 |
| 05 | 临时停车费 | 0 | 0 | 0 | 0 | ¥0.00 |
| 14 | 停车管理费 | 324,000 | 0 | 0 | 324,000 | ¥3,240.00 |
| 16 | 置业泊位费 | 30,000 | 0 | 0 | 30,000 | ¥300.00 |
| — | 合计 | 15,374,220 | 15,000 | -60,000 | 15,314,220 | ¥153,142.20 |

房屋性质拆分实测（同条件，净额；nature_code 行级）：

```sql
SELECT b.fee_code AS fee,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.nature_code)='01'),0) AS nature01_商品房,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.nature_code)='04'),0) AS nature04_商铺,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.nature_code)='06'),0) AS nature06_空房,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND (b.nature_code IS NULL OR TRIM(b.nature_code)='')),0) AS nature_null,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL),0) AS 合计
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01'
GROUP BY b.fee_code ORDER BY b.fee_code;
```

实测：管理费 11,915,220 全在 nature 01；泊位费 3,045,000 中 -60,000 在 nature 01、3,105,000 在「空」性质；停车管理费 324,000、置业泊位费 30,000 均在「空」性质。**说明房屋性质筛选对车位类收费影响极大**。

**需用户截图核对的点**（旧系统：`统计汇总 → 收费汇总`）
1. 选择「管理处 02、2026-10-01~2026-10-31、全部收费项目、全部房屋性质、全部收款方式」，截图：表头、行分组（是否 收费项目×房屋性质）、总计行。
2. 截图「退款块」在哪：是同一张表的另一段，还是切换「状态」后单独出？列头是否写「退款」。
3. 「笔数」列是否包含负调整行。
4. 「其他收费」块是否显示（本库应无数据）。
5. 所属年度区间筛选是否默认当年。

**已可做/缺镜像**：已可做；缺「其他收费」表镜像（本库为空，可标 0 或不显示）；无阻塞。

---

### 4.2 收款汇总表（菜单 #7）

**结论**：⚠️ 部分可做。收款侧（金额/收款日期/收款方式/收款人/收费项目/管理处）可算；旧系统主数据源是「票据开票数据」，`收入(不含税)/税额/票据编号/开票日期/发票代码` 需补镜像，P2 只能先做「金额近似版」并标注差异。

**旧系统定义（EXE offset 1374244，表单名「收款汇总统计表」）**

- 汇总 SQL（原文节选）：
  ```sql
  SELECT 设置管理处.GYD_DH, 设置管理处.GYD_NAME, SetupSFXM.收费类别, SetupSFXM.DH, SetupSFXM.XM,
         SUM(票据开票数据.金额) AS JE,
         SUM(CASE WHEN 票据开票数据.税额 IS NULL THEN 票据开票数据.金额 ELSE 票据开票数据.金额-税额 END) AS SR
  FROM ... 票据/票据开票数据 ... UNION 无票据 WYZJ 收款 ... UNION 车位收款 ...
  GROUP BY 设置管理处.GYD_DH, 设置管理处.GYD_NAME, SetupSFXM.收费类别, SetupSFXM.DH, SetupSFXM.XM;
  ```
- 另有「其中：」按收款方式汇总：`Select WYZJ.收款方式, SUM(WYZJ.ZJ_JE) as JE, SUM(WYZJ.ZJ_JE - WYZJ.收入) as SE`（SE=税额）。
- 明细（表单「收款汇总明细统计」）列：入库单编号、票据编号、付款人、项目、摘要、金额、税额、开票日期、开票人、收款日期、收款人、收款方式、备注、发票代码、地址。
- 抬头单位：上海馨微信息科技有限公司（旧系统供应商抬头）。

**数据源**：旧系统 = `票据`+`票据开票数据`（PMS 未镜像）∪ `WYZJ`（已镜像）∪ 车位表（未镜像）。PMS 镜像可用：`mis_mirror_bill` + `mis_mirror_fee_item`；缺 `WYZJ.收入/税额` 与票据系列。

**口径公式**

```
旧系统「金额 JE」 = 票据开票数据.金额（含税）或 WYZJ.ZJ_JE（无票据时）
旧系统「收入 SR」 = 金额 − 税额（不含税），无票据时 = WYZJ.收入
P2 近似版（仅金额）：
  行：管理处 office_code × 收费项目 fee_code（可加 收费类别/收款方式/收款人）
  值：Σ amount_cents WHERE paid_date ∈ [起,止) AND refund_date IS NULL（有效净额）
      另列 退款 = Σ ABS WHERE refund_date ∈ 区间 AND amount_cents > 0
```

**行列/小计/排序**：行=管理处→收费类别→收费项目（旧系统三级）；列=金额、收入、税额（后两者 P2 缺）；小计按管理处、「其中：」按收款方式；明细默认按收款日期倒序。

**下钻**：汇总行 → 明细行（逐笔账单/票据）；P2 复用 `/statistics/collection/detail`（逐笔）。

**筛选**：管理处、收款日期区间、收费类别/收费项目、收款方式、收款人、开票日期（旧）。

**实测（2026-11-09，管理处 02，2026-10）**

```sql
SELECT b.fee_code AS fee,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method)='现金'),0) AS 现金,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method)='微信'),0) AS 微信,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method)='支付宝'),0) AS 支付宝,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method)='转账'),0) AS 转账,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method)='银联支付'),0) AS 银联,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL),0) AS 合计
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01'
GROUP BY b.fee_code ORDER BY b.fee_code;
```

实测输出（分）：

| fee | 现金 | 微信 | 支付宝 | 转账 | 银联 | 合计（分） | 合计（元） |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01 管理费 | 1,610,820 | 6,152,700 | 1,872,900 | 2,278,800 | 0 | 11,915,220 | ¥119,152.20 |
| 04 泊位费 | -60,000 | 2,790,000 | 315,000 | 0 | 0 | 3,045,000 | ¥30,450.00 |
| 14 停车管理费 | 0 | 324,000 | 0 | 0 | 0 | 324,000 | ¥3,240.00 |
| 16 置业泊位费 | 0 | 30,000 | 0 | 0 | 0 | 30,000 | ¥300.00 |
| 合计 | 1,550,820 | 9,296,700 | 2,187,900 | 2,278,800 | 0 | 15,314,220 | ¥153,142.20 |

按收款人×收款方式（2026-10 全部管理处，验证「其中：」维度；实测 3 行）：

```sql
SELECT COALESCE(NULLIF(TRIM(b.cashier),''),'(未填写)') AS cashier,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method) = '现金'), 0) AS cash,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method) = '微信'), 0) AS wechat,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method) = '支付宝'), 0) AS alipay,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND TRIM(b.payment_method) = '转账'), 0) AS transfer,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL), 0) AS net_cents,
       COUNT(*) FILTER (WHERE b.refund_date IS NULL) AS rows
FROM mis_mirror_bill b
WHERE b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01'
GROUP BY 1 ORDER BY net_cents DESC;
```

实测：赵丽萍 46,508,500（362 行）；刘微微 34,797,740（1,943 行，含转账 3,818,640）；伍庆中 12,007,200（730 行）；合计 93,313,440 分（¥933,134.40）。

**需用户截图核对的点**（旧系统：`统计汇总 → 收款汇总表`）
1. 选择 02 管理处 + 2026-10 收款日期区间，截图汇总表：是「金额 + 收入」两列还是只有金额/合计？
2. 是否分「收费类别」小计，「其中：」收款方式块在表尾还是单独页。
3. 明细页列是否含票据编号/发票代码（本库很多收费无票据编号，需确认旧系统是否显示空）。
4. 车位收款是否单列（旧系统从 车位说明表/申请登记表 取付款人）。

**已可做/缺镜像**：部分可做（金额维度）；**缺镜像**：`WYZJ.收入`（不含税收入）、`票据`/`票据开票数据`（票据号、开票日期、税额）、车位说明表/申请登记表（付款人/地址）。→ P2 先出「金额近似版」，页面注明「不含税收入与票据列待补镜像」。

---

### 4.3 收款日报表（菜单 #6）

**结论**：✅ 已可做；列模板待截图（按收款方式分列 or 按收费项目分列）。

**旧系统定义（EXE offset 1180040）**

- 表单：`收款日报表`；筛选：管理处勾选、「请至少勾选一个收费项目！」「请至少勾选一个收款方式！」、日期范围（「收款截止日期不能早于开始日期」）。
- 统计方式单选：**不分部门统计 / 按部门统计 / 按管理项目统计**；`Select * from 收款方式列表` 动态生成列/行；`报表统计完成！`、需设置打印格式。
- 同一模块旁证：`收款汇总明细统计` 的明细按 `地址/收费项目/收款人/收款方式/收款日期` 分组。

**数据源**：`mis_mirror_bill`（paid_date、refund_date、payment_method、fee_code、office_code、amount_cents）+ `mis_mirror_payment_method`（5 种方式）。

**口径公式**：按收款日期为事件日期；行=日期（区间内每一天，无收款的日期旧系统可能不显示）；列=收费项目（或收款方式）；值=有效净额（`refund_date IS NULL`），退款按退款日期单列或计入负数（**待截图**）。日期区间必须完整自然日 [from, to)。

**行列/小计/排序**：候选模板 A（推荐）：行=日期，列=收费项目，按管理处/部门分块，底部合计；模板 B：行=日期，列=收款方式。排序日期升序；金额右对齐。

**下钻**：单元格 → 当日逐笔（`collection/detail`，dateFrom=dateTo=该日 + 费项/方式筛选）。

**筛选**：管理处✓、收费项目✓（≥1）、收款方式✓（≥1）、日期区间；统计方式（不分部门/按部门/按管理项目）。

**实测（2026-11-09，管理处 02，2026-10-01~2026-10-10）**

```sql
SELECT to_char(paid_date,'YYYY-MM-DD') AS day,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND TRIM(payment_method)='现金'),0) AS 现金,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND TRIM(payment_method)='微信'),0) AS 微信,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND TRIM(payment_method)='支付宝'),0) AS 支付宝,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND TRIM(payment_method)='转账'),0) AS 转账,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL),0) AS 合计
FROM mis_mirror_bill
WHERE office_code='02' AND paid_date >= '2026-10-01' AND paid_date < '2026-10-11'
GROUP BY paid_date ORDER BY paid_date;
```

实测输出（分）：

| 日期 | 现金 | 微信 | 支付宝 | 转账 | 合计（分） | 合计（元） |
|---|---:|---:|---:|---:|---:|---:|
| 2026-10-01 | 0 | 510,000 | 0 | 0 | 510,000 | ¥5,100.00 |
| 2026-10-03 | 0 | 111,000 | 0 | 0 | 111,000 | ¥1,110.00 |
| 2026-10-08 | 0 | 150,000 | 0 | 0 | 150,000 | ¥1,500.00 |
| 2026-10-09 | 59,460 | 15,000 | 0 | 0 | 74,460 | ¥744.60 |
| 2026-10-10 | 0 | 383,520 | 320,160 | 0 | 703,680 | ¥7,036.80 |

2026-10 全月只有 1 个退款日（2026-10-19，管理处 02，2 行，退款 ¥150.00）——见 §4.1/§2.2 的成对退款，日报表若按「退款日期」单列需确认旧系统是否显示。

**需用户截图核对的点**（旧系统：`统计汇总 → 收款日报表`）
1. 选择 02 管理处、收费项目全选、收款方式全选、日期 2026-10-01~2026-10-10，截图表头与合计。
2. 列头是「收款方式」（现金/微信/…）还是「收费项目」；「不分部门/按部门/按管理项目」三者输出的行分组差异。
3. 退款是单独一列/一页，还是直接抵扣当天收款。
4. 无收款的日期（如 2026-10-02）是否显示 0 行。

**已可做/缺镜像**：已可做（无阻塞）。

---

### 4.4 月报表（菜单 #25，旧「收费月报表」）

**结论**：⚠️ 可做，但**旧系统模板不是「月 × 收费项目」**；需按 28 列财务矩阵改造，并先拿截图确认列定义。

**旧系统定义（EXE offset 961120）**

- 表单标题：`收费月报表`；Excel 导出模板区 `A1:AB8`；页眉 `A2`、`A3`、`(收费类别：...)`、`编制单位（盖章）：`、`单位金额: 元`。
- 表头两行（实测字符串）：
  - `A6:A7` 小区（项目）；`B6:B7` 序号/代字
  - `C6:G6` **本期**（组）：C7 月应收、D7 月调整、E7 累计应收、F7 旧欠应收、G7 合计应收
  - `H6:L6` **本期实收数**（组）：H7 收当月、I7 收当年、J7 收旧欠、K7 待确认、L7 收合计
  - `M6:M7` 预收转入；`N` 预收余额
  - `O6:Q6` 累计实收数（3 列）
  - `R6:T6` 本期回收率（3 列）
  - `U6:X6` 本期欠收数（3 列）
  - 其后：账面累计实收、累计溢收、收欠费、当月欠收、当月应收、月调整、累计应收、旧欠应收、合计应收、收当月、收当年、收旧欠、收合计、累计数、旧欠累计数、账款累计、累计、欠收合计
- 相邻发现：`综合月报表` 的「说明」公式给出同类口径（附录 B）。

**数据源**：`mis_mirror_bill`（period、amount_cents、paid_date、refund_date）；旧系统还 join `WYDJ`（缴费通知，用于分等/应收确认）与 `ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq`（记账/调整/变动日期，镜像未同步）。

**口径公式（主推，统计年月 asOfPeriod=202610）**

```
行：管理处 office_code（旧系统为 小区（项目），二者一一映射）
月应收   = Σ amount_cents WHERE refund_date IS NULL AND period = asOfPeriod AND amount>0
月调整   = Σ amount_cents WHERE refund_date IS NULL AND period = asOfPeriod AND amount<0
累计应收 = Σ amount_cents WHERE refund_date IS NULL AND period <= asOfPeriod AND amount>0
旧欠应收 = Σ amount_cents WHERE refund_date IS NULL AND paid_date IS NULL AND period <= 上年12月 AND amount>0
本期实收 = Σ amount_cents WHERE refund_date IS NULL AND paid_date ∈ [月初, 下月初)
预收转入 = Σ amount_cents WHERE refund_date IS NULL AND paid_date < 月初 AND period = asOfPeriod
预收余额 = Σ amount_cents WHERE refund_date IS NULL AND paid_date < 下月初 AND period > asOfPeriod
当月欠收 = Σ amount_cents WHERE refund_date IS NULL AND paid_date IS NULL AND period = asOfPeriod AND amount>0
累计欠收 = Σ amount_cents WHERE refund_date IS NULL AND paid_date IS NULL AND period <= asOfPeriod AND amount>0
本期回收率 = 本期实收 / 合计应收（分母待截图确认）
```

**行列/小计/排序**：行=小区（项目）/管理处（旧系统可按管理处或按小区）；列=28 列指标；底部合计/小计；金额右对齐，回收率百分比 2 位小数。

**下钻**：任一金额列 → 明细（按房屋/收费项目）→ 逐笔；实现可复用 P1 明细/逐笔 + 增加 asOfPeriod 与列对应的筛选条件。

**筛选**：统计年月、管理处/小区、收费类别、收费项目、房屋性质（旧表单有「请确定房屋性质!」提示）。

**实测（2026-11-09，统计年月 202610，按管理处）**

```sql
SELECT office_code AS office,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND period='202610' AND amount_cents>0),0) AS 月应收,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND period='202610' AND amount_cents<0),0) AS 月调整,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND period<='202610' AND amount_cents>0),0) AS 累计应收,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date IS NULL AND period<='202512' AND amount_cents>0),0) AS 旧欠应收,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date >= '2026-10-01' AND paid_date < '2026-11-01'),0) AS 本期实收,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date < '2026-10-01' AND period='202610'),0) AS 预收转入,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date < '2026-11-01' AND period>'202610'),0) AS 预收余额,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date IS NULL AND period='202610' AND amount_cents>0),0) AS 当月欠收,
       COALESCE(SUM(amount_cents) FILTER (WHERE refund_date IS NULL AND paid_date IS NULL AND period<='202610' AND amount_cents>0),0) AS 累计欠收
FROM mis_mirror_bill GROUP BY 1 ORDER BY 1;
```

实测输出（分）：

| 管理处 | 月应收 | 月调整 | 累计应收 | 旧欠应收 | 本期实收 | 预收转入 | 预收余额 | 当月欠收 | 累计欠收 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 01 | 14,590,330 | -75,000 | 2,478,340,466 | 33,865,830 | 15,246,910 | 7,210,960 | 33,437,560 | 5,560,990 | 87,340,540 |
| 02 | 15,213,860 | -110,000 | 2,899,940,950 | 9,921,090 | 15,314,220 | 7,054,720 | 29,882,290 | 6,202,090 | 70,235,030 |
| 03 | 18,547,350 | -47,770 | 3,559,990,790 | 7,424,950 | 16,243,810 | 7,390,860 | 29,562,020 | 8,973,510 | 95,436,170 |
| 04 | 63,820,600 | -598,600 | 6,733,135,600 | 3,093,000 | 46,508,500 | 11,168,600 | 48,066,200 | 32,251,900 | 35,608,500 |
| 合计 | 112,172,140 | -831,370 | 15,671,407,806 | 54,304,870 | 93,313,440 | 32,825,140 | 140,948,070 | 52,988,490 | 288,620,240 |

（合计为四行相加，元：本期实收 ¥933,134.40、当月欠收 ¥529,884.90、累计欠收 ¥2,886,202.40。）

**需用户截图核对的点**（旧系统：`统计汇总 → 月报表`）
1. 选择「2026-10」统计年月 + 全部管理处，截图整张表：列头两层全称、行维度（小区/管理处）、合计行。
2. `H6:L6 本期实收数` 的 5 个子列（收当月/收当年/收旧欠/第 4 列/收合计）确切含义。
3. `O6:Q6 累计实收数`、`R6:T6 本期回收率`、`U6:X6 本期欠收数` 的 3 个子列。
4. `K7`、`AA/AB` 两列（当月应收/月应收）的差异。
5. 「本期回收率」分母（合计应收？应缴户数？）。
6. 本报表是否只出一行「全公司合计」还是按管理处多行。

**已可做/缺镜像**：核心 9 个指标已可做；28 列中还有约 10 列定义未知，需截图；`ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq` 未镜像（影响欠收截止判断，源库非空仅 31/33/10 行，可先忽略并标注）。

---

### 4.5 综合月报表B（菜单 #8）

**结论**：⚠️ 部分可做。核心金额列可算；旧系统 33 列模板 + 统计维度需截图后实现。

**旧系统定义（EXE offset 1335464 / 1329814，表单「综合月报表」）**

- 统计维度单选：`按小区统计`、`按街坊统计`、`按门牌统计`、`按室号统计`、`按小区统计_车位`、`按车库_车位`、`按车主_车位`。
- 列头（33 列，实测字符串，`|` 分隔、合并表头逐列重复）：
  `号 | 小区（项目） | 本期×5~6 | 本期实收数×5~6 | 预收转入 | 预收余额 | 累计实收数×3~4 | 本期回收率×3 | 累计回收率×3 | 本期欠收数×3 | 账面累计实收×3 | 累计溢收 | 收欠费 | 当月欠收`
- 公式说明（实测原文）：
  `[4]=[2]+[3]的累加数；[6]=[4]+[5]；[11]=[7]+[8]+[9]+[10]；[13]=上月[13]-[12]+[10]；[14]=上月[14]+[7]+[8]+[12]；[15]=上月[15]+[9]；[17]=([7]+[12])/[2]；[18]=[14]/[4]；[19]=[15]/[5]；[20]=([14]+[15])/[6]；[21]=[4]-[14]；[22]=[5]-[15]；[23]=[21]+[22]；[24]=上月[24]+[11]；[26]=[8]+[9]；[27]=[2]-[7]-[12]`
- 导出配置 `综合月报表.INI`（运行期生成/本地未留存）；页脚 经理/审核/制表；另有「营改增」变体（34 列，含 收合计/实收/税额/合计）。

**数据源**：`mis_mirror_bill` + `mis_mirror_building`（门牌）+ `mis_mirror_room`（室/面积）+ `mis_mirror_office` 映射；旧系统 `YWH`（业委会/街坊）未镜像 → 「按街坊统计」需补镜像。

**口径公式（候选）**

```
行：所选统计维度实例（管理处/门牌/室/车库）
列：33 指标；其中可算：本期应收(period 区间)、本期实收(paid_date 区间，refund null)、
    预收转入、预收余额、累计实收、本期欠收、累计溢收、当月欠收（公式见 §4.4 / 实测 Q23）
    回收率 = 实收 / 应收（分母与舍入待截图）
筛选：统计年月、管理处、收费类别、房屋性质
```

**行列/小计/排序**：行=维度实例（管理处/门牌/室号），列=33 指标（横向滚动）；小计/合计行；导出 Excel。

**下钻**：点行 → 该房屋/门牌明细 → 逐笔。

**筛选**：统计年月、管理处/小区、统计维度（小区/街坊/门牌/室号/车库/车主）、收费类别、房屋性质。

**实测（2026-11-09，2026 年按月×管理处有效净额）**

```sql
SELECT EXTRACT(MONTH FROM b.paid_date)::int AS month,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.office_code='01'),0) AS o01,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.office_code='02'),0) AS o02,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.office_code='03'),0) AS o03,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.office_code='04'),0) AS o04,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL),0) AS total
FROM mis_mirror_bill b
WHERE b.paid_date >= '2026-01-01' AND b.paid_date < '2027-01-01'
GROUP BY 1 ORDER BY 1;
```

实测（分，2026-01~2026-11；12 月未到）：

| 月 | 01 | 02 | 03 | 04 | 合计（分） | 合计（元） |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 8,065,640 | 6,747,360 | 10,609,730 | 92,312,900 | 117,735,630 | ¥1,177,356.30 |
| 2 | 8,241,550 | 3,483,070 | 5,464,930 | 31,026,000 | 48,215,550 | ¥482,155.50 |
| 3 | 11,495,180 | 5,289,790 | 7,113,380 | 91,761,000 | 115,659,350 | ¥1,156,593.50 |
| 4 | 8,813,180 | 7,487,590 | 5,213,710 | 58,822,700 | 80,337,180 | ¥803,371.80 |
| 5 | 9,889,430 | 4,199,670 | 7,067,990 | 42,355,500 | 63,512,590 | ¥635,125.90 |
| 6 | 7,395,840 | 9,702,230 | 6,799,540 | 81,883,500 | 105,781,110 | ¥1,057,811.10 |
| 7 | 9,837,100 | 8,009,300 | 7,952,740 | 58,562,000 | 84,361,140 | ¥843,611.40 |
| 8 | 6,972,340 | 6,731,640 | 6,975,330 | 38,306,200 | 58,985,510 | ¥589,855.10 |
| 9 | 7,637,600 | 8,022,470 | 7,211,620 | 94,519,000 | 117,390,690 | ¥1,173,906.90 |
| 10 | 15,246,910 | 15,314,220 | 16,243,810 | 46,508,500 | 93,313,440 | ¥933,134.40 |
| 11（至 11-09） | 8,133,100 | 10,186,230 | 13,828,680 | 12,510,000 | 44,658,010 | ¥446,580.10 |

**需用户截图核对的点**（旧系统：`统计汇总 → 综合月报表B`）
1. 统计年月选 2026-10，统计维度「按小区」，截图完整 33 列表头（两层）。
2. 统计维度切换「按门牌/按室号」后的第一列与行数。
3. 本期 5/6 个子列与累计组 3/4 个子列的列名。
4. 回收率分母与小数位；「收欠费」列含义。
5. 是否有「按街坊（业委会）」需求（需补 YWH 镜像）。

**已可做/缺镜像**：部分可做；缺 `YWH`（街坊/业委会）、车位说明/申请登记表（车库/车主维度）、`WYDJ`（应收通知，若列定义依赖）。

---

### 4.6 综合月报表C

**结论**：⏸ 菜单快照中不存在「综合月报表C」，**不实现**，等用户确认定义。

- 2026-11-06 MIS 快照 `ApplicationModule`：统计汇总下只有 `综合月报表B`（#187）；另在「商用统计报表」菜单有 `综合月报表`（#277）。
- 客户端 EXE 中存在 `综合月报表`（33 列，普通版）与 `综合月报表(营改增)`（34 列，含 收合计/实收/税额/合计），推测用户所说「综合月报表C」是其中之一（最可能是营改增版）。
- **未执行 SQL**：C 的列定义未知，不伪造。若确认是营改增版：需补 `WYZJ.收入`（不含税金额）与税控设置（税率/税额），归入 P4（与收款汇总表的收入/税额缺口合并）。
- 需用户提供：C 在旧系统菜单中的**位置截图** + 完整表头截图 + 一行示例数据。

**已可做/缺镜像**：挂起（定义缺失 + 收入/税额镜像缺失）。

---

### 4.7 分等综合月报表（菜单 #15）

**结论**：❌ **不可做**（源库无分等数据；旧系统在此库同样会报错）。建议 P2 不做，改由用户确认替代维度（房屋性质可做）。

**旧系统定义（EXE offset 967620 / 965822）**

- 表单：`分等综合月报表`；统计维度：按小区/街坊/门牌/室号/车库/车主；筛选：统计年月（「统计年月非法」）、小区（项目）、收费项目、房屋性质。
- 关键 SQL（原文节选）：
  ```sql
  ... FROM WYZJ
      INNER JOIN 业主表 ON WYZJ.Zh_ID = 业主表.Zh_ID
      INNER JOIN 室表  ... INNER JOIN 楼表 ... INNER JOIN 设置管理处 ...
      INNER JOIN WYDJ ON WYZJ.Zh_ID = WYDJ.ZH_ID
  WHERE 楼表.管理处 = N'xx'
    AND WYZJ.FWXZ_DH IN (...)
    AND Not WYDJ.分等标准 Is Null AND WYDJ.HISTROY = 0      -- 必须有分等标准
    AND ((ZJ_Cny >= '起' AND ZJ_Cny <= '止') OR ...记账/调整/退款/变动日期条件...)
  -- 另：INNER JOIN 分等收费标准明细 ON WYDJ.分等标准 = 分等收费标准明细.分等代号
  --     AND 分等收费标准明细.执行年月 <= 统计年月 AND (取消年月 IS NULL OR 取消年月 > 统计年月)
  ```
- 列头（30 列）：`序号 | 分等项目 | 本期×5 | 本期实收数×5 | 预收转入 | 预收余额 | 累计实收数×3 | 本期回收率×3 | 累计回收率 | 本期欠收数×3 | 账面累计实收 | 累计溢收 | 收欠费 | 当月欠收`（与综合月报表同构，只把行维度换成「分等项目」）。
- 旧系统错误提示：「不是分等收费项目或没有设置分等收费标准」。

**数据现况（2026-11-06 MIS 本地快照，只读 CSV，未连 MIS）**

| 对象 | 现状 |
|---|---|
| `室表.分等收费标准` | 2,346 行**全部为空** |
| `WYDJ.分等标准` | 7,037 行**全部为空** |
| `分等收费标准` / `分等收费标准明细` | **0 行**（只有表头） |
| PMS `mis_mirror_room` | **无「分等收费标准」列**（只有 s_id/l_id/room_no/nature/area_sqm/synced_at） |

**实测（2026-11-09，镜像室表字段与性质分布）**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='mis_mirror_room' ORDER BY ordinal_position;
SELECT COALESCE(NULLIF(TRIM(nature),''),'(空)') AS nature, COUNT(*) AS rooms
FROM mis_mirror_room GROUP BY 1 ORDER BY 1;
```

实测：`mis_mirror_room` 仅 6 列（无分等列）；性质分布 01=1,975、04=74、05=15、06=10、07=263、08=8、空=1。

**需用户截图核对的点**
1. 旧系统打开「统计汇总 → 分等综合月报表」时是否直接弹出「不是分等收费项目或没有设置分等收费标准」。
2. 确认是否仍需要这张报表；若需要，分等标准定义从哪来（旧系统「系统设置 → 分等收费标准设置」是否有配置）。
3. 是否接受用「房屋性质」替代分等维度出综合月报（可做，复用 §4.5）。

**已可做/缺镜像**：不可做——**缺数据 + 缺镜像**；旧系统在本库也无数据。建议 P2 从范围移除。

---

### 4.8 收款分析（菜单 #5）

**结论**：✅ 已可做（按户：历年欠收 / 当年欠收 / 当月应收 / 预缴 / 区间实收）；列名与日期基准待截图。

**旧系统定义（EXE offset 957040）**

- 表单：`收款分析`；筛选：统计日期范围（收款日期）、管理处、收费项目、门牌；「统计完成」。
- 按户聚合 SQL（原文片段）：
  ```sql
  SELECT Sum(ZJ_Je) as LNQ, WYZJ.ZH_ID ...      -- 历年欠收（period < 当年）
  SELECT Sum(ZJ_Je) as DNQ, WYZJ.ZH_ID ...      -- 当年欠收（period ∈ 当年）
  SELECT Sum(ZJ_Je) as DY,  WYZJ.ZH_ID ...      -- 当月（应收）
  SELECT Sum(ZJ_Je) as YJ,  WYZJ.ZH_ID ...      -- 预缴（period > 统计月）
  ...
  SELECT 地址..., 业主表.姓名, 业主表.说明, LNQ, DNQ, DY, YJ ...
  WHERE ZJ_Skrq Between '起' AND '止' AND ZJ_Cny < '...' AND ZJ_LX IN (...)
  ```
- 另一路按租赁户 `ZL_ID` 聚合（租赁户分析）；列名 LNQ/DNQ/DY/YJ 的中文表头需截图确认（推断为 历年欠收/当年欠收/当月应收/预缴）。

**数据源**：`mis_mirror_bill` + `mis_mirror_room` + `mis_mirror_owner`（地址/姓名/面积）；租赁维度需 `ZL_ID`（镜像无，且旧租赁户表未镜像）→ P2 只做「按户（业主）」版。

**口径公式**

```
行：房屋（s_id）：地址、业主、建筑面积、说明（新进户/迁出需补镜像）
列：历年欠收 = Σ amount WHERE refund IS NULL AND paid IS NULL AND period < 当年01 AND amount>0
    当年欠收 = Σ amount WHERE refund IS NULL AND paid IS NULL AND period ∈ 当年 AND period <= asOfPeriod AND amount>0
    当月应收 = Σ amount WHERE refund IS NULL AND period = asOfPeriod AND amount>0
    预缴     = Σ amount WHERE refund IS NULL AND paid IS NOT NULL AND period > asOfPeriod AND amount>0
    区间实收 = Σ amount WHERE refund IS NULL AND paid_date ∈ [起,止)
筛选：管理处、收费项目、门牌、收款日期区间、统计年月
排序：当年欠收降序（或地址序）
```

**下钻**：点户 → 逐笔账单（含所属年月/金额/收款日期/收款方式/收款人）；复用 P1 逐笔端点。

**筛选**：管理处✓、收费项目✓、门牌（楼栋）、收款日期区间、统计年月。

**实测（2026-11-09，管理处 02，截至 202610，前 5 户）**

```sql
SELECT b.s_id, MAX(b.address) AS address, MAX(b.owner_name) AS owner,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NULL AND b.period<'202601' AND b.amount_cents>0),0) AS 历年欠收,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NULL AND substr(b.period,1,4)='2026' AND b.period<='202610' AND b.amount_cents>0),0) AS 当年欠收,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.period='202610' AND b.amount_cents>0),0) AS 当月应收,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NOT NULL AND b.period>'202610' AND b.amount_cents>0),0) AS 预缴,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date >= '2026-10-01' AND b.paid_date < '2026-11-01'),0) AS 区间实收
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.period <= '202712'
GROUP BY b.s_id ORDER BY 当年欠收 DESC NULLS LAST LIMIT 5;
```

实测（分）：

| 房屋 | 业主 | 历年欠收 | 当年欠收 | 当月应收 | 预缴 | 区间实收（2026-10） |
|---|---|---:|---:|---:|---:|---:|
| 宝秀路701号701 | 陆乾一 | 0 | 1,514,300 | 166,430 | 90,000 | 15,000 |
| 宝秀路723-725号723-725 | 杨凤林 | 0 | 826,400 | 82,640 | 0 | 0 |
| 永德路228弄31号1101 | 邱解平 | 0 | 374,000 | 44,150 | 13,500 | 0 |
| 永德路228弄23号1001 | 周福顺 | 0 | 361,600 | 42,910 | 74,250 | 81,000 |
| 永德路228弄22号1101 | 杜剑烨 | 0 | 347,000 | 34,700 | 0 | 0 |

（本样例 5 户历年欠收均为 0，说明 02 管理处历史欠费集中在少数户；全量按历年欠收排序可另验。）

**需用户截图核对的点**（旧系统：`统计汇总 → 收款分析`）
1. 选择 02 管理处、收费项目全选、门牌全选、统计年月 202610，截图列头（LNQ/DNQ/DY/YJ 的中文名）。
2. 收款日期区间在报表里是独立一列（区间实收）还是仅用于过滤。
3. 排序规则（欠收降序/地址序）、是否含迁出户。
4. 是否还有「按租赁户」页签（PMS 无租赁镜像）。

**已可做/缺镜像**：按户版已可做；租赁户维度、业主「说明/迁出」字段缺镜像（P4）。

---

### 4.9 日常收费项目收款日报表（菜单 #14）

**当前实现（2026-11-10，第 10 轮）**：已启用 `daily-fees` 入口，与收款日报表共用 `/statistics/daily`；这是明确标注的当前费项矩阵实现，**不是已逐列核验的旧模板复刻**。旧模板列、收款方式分组和收费类别范围仍待原表证据，不自动限定“日常收费”类别。未部署生产。

**旧系统定义**：该菜单项 id=323 晚于客户端主体（2011 版），`物业管理.exe` 中**未找到**同名窗体字符串（`日常收费项目收款日报表` 0 命中），推断为后续升级加入或与「收款日报表」共用框架。P2-A 的实现（行=日期、列=收费项目）与该名称语义一致，作为主推模板。

**当前数据口径**：`mis_mirror_bill`。费项列及“收款合计”仅含 `paid_date` 范围内无退款日期的正数收款；退款按 `refund_date` 的原正数行取绝对值，成对负数不重复计；无退款日期的负数按 `paid_date` 计入独立“调整”列。**三块分开，不把收款合计称为净额**。列来自选中字典（不硬编码 16 列）。

**行列/小计/排序**：业务日期升序；仅退款/调整日期也保留，全零日期不补行。费项列后是收款合计、退款、调整；末行合计分别等于对应列之和。

**下钻**：日期×费项、日期收款合计、期间费项合计、期间收款总计、每日/期间退款与调整均可查逐笔。费项及日期严格收敛；全费项目标沿用已应用收费项目多选，非尚未统计的草稿。明细按 `kind=received/refund/adjust`，分类合计读取 API 的 `totals`，退款额保持正数，调整保持符号；未就绪不显示假 0。

**筛选/导出**：管理处、收费项目、房屋性质多选及必填业务日期区间（跨度≤366 天）。CSV 使用当前报表名称、已应用筛选、同表行列合计，带 UTF-8 BOM 和公式防护，负调整保留可计算数字。

**历史 SQL 抽查（2026-11-09，管理处 02，2026-10-01~2026-10-10）**：以下把负调整直接加在费项列，**不等同于当前正收款矩阵的期望值**；不得将这批历史数字当成本轮生产验收。本轮未连接生产。

```sql
SELECT to_char(b.paid_date,'YYYY-MM-DD') AS day,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.fee_code='01'),0) AS f01,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.fee_code='04'),0) AS f04,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.fee_code='05'),0) AS f05,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.fee_code='14'),0) AS f14,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL),0) AS total
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.paid_date >= '2026-10-01' AND b.paid_date < '2026-10-11'
GROUP BY b.paid_date ORDER BY b.paid_date;
```

实测（分）：

| 日期 | 01 管理费 | 04 泊位费 | 05 临停 | 14 停车管理费 | 合计（分） | 合计（元） |
|---|---:|---:|---:|---:|---:|---:|
| 2026-10-01 | 0 | 510,000 | 0 | 0 | 510,000 | ¥5,100.00 |
| 2026-10-03 | 0 | 30,000 | 0 | 81,000 | 111,000 | ¥1,110.00 |
| 2026-10-08 | 0 | 150,000 | 0 | 0 | 150,000 | ¥1,500.00 |
| 2026-10-09 | 119,460 | -45,000 | 0 | 0 | 74,460 | ¥744.60 |
| 2026-10-10 | 553,680 | 150,000 | 0 | 0 | 703,680 | ¥7,036.80 |

（10-09 泊位费 −¥450.00 为负调整 R3，说明日报表必须能显示负数。）

**需用户截图核对的点**（旧系统：`统计汇总 → 日常收费项目收款日报表`）
1. 列头是否为 16 个收费项目（含无流水的 0 列）。
2. 日期行是否包含无收款日。
3. 退款是否单列；负调整是否直接抵扣。
4. 管理费是否按「日常收费」类别过滤。

**本轮验证**：P2 后端 19/19，全统计后端 P1–P8 88/88（108042ms）；前后端 typecheck 通过；完整统计浏览器 18/18（160537ms）。新增合成日报覆盖完整月份/仅退款与负调整日期、八类金额及合计下钻、已应用快照、CSV、1440/390/320、等待/失败/未同步/重试。后端逐日三块与逐费项收款合计对照真实 service 明细返回 `totals`，前端夹具同步该契约。截图见[桌面金额区](<D:/pms-statistics-evidence/statistics-daily-fees-amounts-1440.png>)、[320 窄屏](<D:/pms-statistics-evidence/statistics-daily-fees-320.png>)、[负调整逐笔](<D:/pms-statistics-evidence/statistics-daily-adjust-detail-1440.png>)。本轮为隔离数据库与合成浏览器夹具，不证明生产正式入口或旧模板完全一致。实现 `f68669af` 合入并推送 main 后，前端正式构建 `tsc --noEmit && vite build` 通过（20.07s，>500KB 分块提示保留）；构建时前端无未提交修改，其他任务 API/文档 WIP 未纳入提交，未上传产物。

---

### 4.10 欠收与溢收汇总（菜单 #9；并覆盖 #26–#29 项目欠费/溢收统计）

**结论**：✅ 已可做（欠收 + 预收两页签）；精确复刻需补 `ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq`（影响很小）。

**旧系统定义（EXE offset 1585265 / 931140–935304 / 933464）**

- 表单结构：`欠收统计` 页签 + `溢收统计` 页签（各自 Grid/List/Check 控件）；另见「项目欠费统计/项目欠费汇总统计/项目溢收统计/项目溢收汇总统计」独立表单（同源 SQL）。
- 欠收明细列头（实测）：
  `<序 |<地址 |<姓名 |>建筑面积 |<收费项目 |<欠费年月范围 |>欠费月份数 |>欠费金额 |<说明 |查看`（另有带「收费年月范围/收费月份数/收费金额」= 溢收版）
  以及一条「<序 |<收费项目 |<应收年月 |<金额 |<收款日期」的单户逐笔清单。
- 欠收条件（原文节选）：
  ```sql
  WHERE (ZJ_SKRQ IS NULL OR ZJ_SKRQ > '收款截止日期')
    AND ZJ_Cny <= '统计年月'
    AND (ZJ_Jzrq IS NULL OR Left(ZJ_Cny,4)*12+Right(ZJ_Cny,2) < datename(yyyy,ZJ_jzrq)*12+datename(mm,ZJ_jzrq))
    AND (ZJ_BDRQ IS NULL OR ZJ_bdrq <= '统计年月')
    AND 楼表.L_ID IN (...) AND WYZJ.ZJ_LX IN (...) AND WYZJ.FWXZ_DH IN (...)
  ```
- 溢收（预收）条件（原文节选）：`ZJ_SKRQ IS NULL OR ZJ_SKRQ > 收款截止日期` + `ZJ_Cny` 落在统计区间 + 已收行取 `MIN(period)-MAX(period)` 作「收费年月范围」。
- 提示：「请输入统计年月！/请输入收款截止日期！/开始年月不能大于截止年月/未选择房屋性质,是否忽略房屋性质？」。

**数据源与关键字段**：`mis_mirror_bill`（period、paid_date、refund_date、amount_cents、s_id、fee_code、nature_code）；缺 `ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq`。

**口径公式**

```
欠收（截至 asOfPeriod / 收款截止日）：
  行：房屋 × 收费项目（地址/业主/面积/欠费年月范围/欠费月份数/欠费金额/说明）
  欠费金额 = Σ amount_cents WHERE paid_date IS NULL AND refund_date IS NULL
             AND period <= asOfPeriod AND amount_cents > 0
  欠费年月范围 = MIN(period)~MAX(period)；欠费月份数 = COUNT(DISTINCT period)
溢收（预收）：
  溢收金额 = Σ amount_cents WHERE paid_date IS NOT NULL AND refund_date IS NULL
             AND period > asOfPeriod AND amount_cents > 0
  收费年月范围 = MIN(period)~MAX(period)；收费月份数 = COUNT(DISTINCT period)
```

**行列/小计/排序**：两页签分别 明细行（房屋×费项）+ 合计行；金额降序（旧系统按地址序，需截图）；「说明」列取车位编号/车库（源 `车位申请登记表`，未镜像 → 可留空标「缺镜像」）。

**下钻**：行 → 该户该费项逐笔（P1 逐笔端点）。

**筛选**：管理处✓、楼栋/门牌✓、收费项目✓、房屋性质✓、统计年月、收款截止日期。

**实测（2026-11-09，截至 202610）**

按管理处汇总：

```sql
SELECT office_code AS office,
       COALESCE(SUM(amount_cents) FILTER (WHERE paid_date IS NULL AND refund_date IS NULL AND period<='202610' AND amount_cents>0),0) AS arrears_due_cents,
       COUNT(*) FILTER (WHERE paid_date IS NULL AND refund_date IS NULL AND period<='202610' AND amount_cents>0) AS arrears_due_rows,
       COALESCE(SUM(amount_cents) FILTER (WHERE paid_date IS NOT NULL AND refund_date IS NULL AND period>'202610' AND amount_cents>0),0) AS prepaid_over_cents,
       COUNT(*) FILTER (WHERE paid_date IS NOT NULL AND refund_date IS NULL AND period>'202610' AND amount_cents>0) AS prepaid_rows
FROM mis_mirror_bill GROUP BY 1 ORDER BY 1;
```

实测：

| 管理处 | 欠收金额（分） | 欠收（元） | 欠收行数 | 溢收/预收（分） | 溢收（元） | 溢收行数 |
|---|---:|---:|---:|---:|---:|---:|
| 01 | 87,340,540 | ¥873,405.40 | 3,705 | 36,416,380 | ¥364,163.80 | 2,402 |
| 02 | 70,235,030 | ¥702,350.30 | 3,394 | 33,252,430 | ¥332,524.30 | 2,241 |
| 03 | 95,436,170 | ¥954,361.70 | 4,082 | 33,911,360 | ¥339,113.60 | 2,349 |
| 04 | 35,608,500 | ¥356,085.00 | 428 | 57,957,200 | ¥579,572.00 | 654 |
| 合计 | 288,620,240 | ¥2,886,202.40 | 11,609 | 161,537,370 | ¥1,615,373.70 | 7,646 |

按收费项目（欠收/溢收）：

```sql
SELECT b.fee_code AS fee,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.paid_date IS NULL AND b.refund_date IS NULL AND b.period<='202610' AND b.amount_cents>0),0) AS arrears_due_cents,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.paid_date IS NOT NULL AND b.refund_date IS NULL AND b.period>'202610' AND b.amount_cents>0),0) AS prepaid_over_cents
FROM mis_mirror_bill b GROUP BY 1 ORDER BY 1;
```

实测（分）：01 管理费 229,750,490 / 26,219,420；02 租金 32,332,500 / 53,743,200；04 泊位费 23,091,000 / 74,179,000；05 临停 120,500 / 0；14 停车管理费 2,575,750 / 6,000,750；15 空房租金 750,000 / 0；16 置业泊位 0 / 1,395,000。

明细 SQL（欠收，管理处 02，截至 202610，前 5）：

```sql
SELECT b.s_id, MAX(b.address) AS address, MAX(b.owner_name) AS owner,
       b.fee_code, MIN(b.period) AS 欠费起, MAX(b.period) AS 欠费止,
       COUNT(DISTINCT b.period) AS 月份数,
       COALESCE(SUM(b.amount_cents),0) AS 欠费金额
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.refund_date IS NULL AND b.paid_date IS NULL
      AND b.period<='202610' AND b.amount_cents>0
GROUP BY b.s_id, b.fee_code ORDER BY 欠费金额 DESC LIMIT 5;
```

明细样例（管理处 02 欠收前 5，实测）：

| 房屋 | 业主 | 费项 | 欠费年月范围 | 月份数 | 欠费金额（分） | 元 |
|---|---|---|---|---:|---:|---:|
| 永德路228弄3号402 | 朱全锋 | 04 | 201404-202011 | 16 | 1,582,500 | ¥15,825.00 |
| 宝秀路701号701 | 陆乾一 | 01 | 202601-202610 | 10 | 1,514,300 | ¥15,143.00 |
| 宝秀路723-725号723-725 | 杨凤林 | 01 | 202601-202610 | 10 | 826,400 | ¥8,264.00 |
| 永德路228弄3号101 | 陈刚 | 14 | 201201-201211 | 11 | 819,500 | ¥8,195.00 |
| 永德路228弄25号1403 | 阮柳洪 | 01 | 202501-202610 | 22 | 533,940 | ¥5,339.40 |

溢收明细 SQL（管理处 02，截至 202610，前 5；`period > 202610` 即预收）：

```sql
SELECT b.s_id, MAX(b.address) AS address, MAX(b.owner_name) AS owner,
       b.fee_code, MIN(b.period) AS 收费起, MAX(b.period) AS 收费止,
       COUNT(DISTINCT b.period) AS 月份数,
       COALESCE(SUM(b.amount_cents),0) AS 预收金额
FROM mis_mirror_bill b
WHERE b.office_code='02' AND b.refund_date IS NULL AND b.paid_date IS NOT NULL
      AND b.period>'202610' AND b.amount_cents>0
GROUP BY b.s_id, b.fee_code ORDER BY 预收金额 DESC LIMIT 5;
```

溢收明细样例（管理处 02 前 5，实测）：

| 房屋 | 业主 | 费项 | 收费年月范围 | 月份数 | 预收金额（分） | 元 |
|---|---|---|---|---:|---:|---:|
| 永德路228弄33号1202 | 邹庆萍 | 01 | 202611-202712 | 14 | 523,180 | ¥5,231.80 |
| 永德路228弄1号103 | 王晶 | 04 | 202611-202710 | 12 | 330,000 | ¥3,300.00 |
| 永德路228弄53号403 | 沈天威 | 04 | 202611-202710 | 12 | 315,000 | ¥3,150.00 |
| 永德路228弄1号502 | 高萍 | 04 | 202611-202709 | 11 | 315,000 | ¥3,150.00 |
| 永德路228弄32号601 | 宫建新 | 01 | 202611-202712 | 14 | 306,600 | ¥3,066.00 |

**需用户截图核对的点**（旧系统：`统计汇总 → 欠收与溢收汇总`）
1. 两个页签的完整列头与「说明」列内容。
2. 欠费月份数算法（去重月份 vs 笔数），欠费年月范围是否合并跨年。
3. 溢收是否只统计「收费年月范围起 > 统计年月」（本例为 202611 起）。
4. 统计年月与收款截止日期两个筛选如何共同生效（旧 SQL 两个都用）。
5. 合计行是「按管理处合计」还是「全部合计」。

**已可做/缺镜像**：已可做；精确复刻缺 `ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq`（记账/调整/变动日期）与「说明」列的车位表；影响仅个别历史行。

---

### 4.11 收缴考核（菜单 #30）

**结论**：✅ 已可做（行=房屋；列=12 个月的应收/收款 + 合计应收/合计已收 + 收缴率）；收缴率分母与「已收归属」口径待截图。

**旧系统定义（EXE offset 952946 / 949180，表单「收缴情况统计」）**

- 筛选：统计年份（「】 统计年份: 」）、管理处、楼栋（`楼表.L_ID IN (...)`）、收费项目（「您没有选择收费项目，无法进行统计！」）、房屋性质（`WYZJ.FWXZ_DH In (...)`）；选项「全部项目（默认）」。
- 明细 Grid 列头（实测）：
  `<序 |<地址 |<住户 |>1月 |>收款 |>2月 |>收款 ... |>12月 |>收款 |>合计应收 |>合计已收`
  并按半年/季度拆出多组（`1–6月`、`7–12月`、`1–3月`、`4–6月`、`7–9月`、`10–12月`）用于分页打印。
- 汇总指标：「按应缴户数统计：」「按应缴户数统计收缴率：」「按金额统计：」「按金额统计收缴率：」。
- 应收 SQL（原文片段）：
  ```sql
  SELECT 业主表.ZH_ID, 说明, 姓名, 地址...
  FROM 室表 INNER JOIN 业主表 ON 室表.S_ID=业主表.S_ID
       INNER JOIN 楼表 ON 室表.L_ID=楼表.L_ID
       INNER JOIN WYZJ ON 业主表.ZH_ID=WYZJ.ZH_ID
  WHERE 楼表.L_ID IN (...) AND ZJ_CNY Between '202601' AND '202606'   -- 或 7–12 月
    AND WYZJ.FWXZ_DH In (...) AND ZJ_LX IN (...)
  GROUP BY 地址..., 业主表.ZH_ID, 业主表.说明, 姓名, 室表.室, 室表.字
  ```
- 已收 SQL（原文片段）：`SELECT WYZJ.ZJ_CNY, SUM(WYZJ.ZJ_Je) as Je, MAX(zj_skrq) as zj_skrq FROM WYZJ WHERE ZH_ID=... AND ZJ_SKRQ<='截止' AND ZJ_SKRQ IS NOT NULL GROUP BY ZJ_CNY`。
- 迁出标记：「迁出」「迁出]」。

**数据源与关键字段**：`mis_mirror_bill`（period、paid_date、amount_cents、refund_date、fee_code、nature_code）+ `mis_mirror_room`（area）+ `mis_mirror_owner`（姓名）；业主「说明（新进户/迁出）」未镜像。

**口径公式（主推）**

```
行：房屋（管理处 + 楼栋/门牌 + 室号 + 业主）
列：1–12 月 × (应收, 收款) + 合计应收 + 合计已收
  月应收(月m) = Σ amount_cents WHERE refund_date IS NULL AND period = 年+m AND amount_cents>0
  月收款(月m) = Σ amount_cents WHERE refund_date IS NULL AND paid_date ∈ 该月 AND period 归属年 (口径A)
               或 Σ amount_cents WHERE refund_date IS NULL AND paid_date ∈ 该月 (口径B，收款流水)
  合计应收 = Σ 12 个月应收
  合计已收 = Σ 12 个月收款
  收缴率(金额) = 合计已收 / 合计应收；收缴率(户数) = 有收款的户数 / 应缴户数
汇总层：按管理处/小区聚合（行=管理处）
```

**行列/小计/排序**：行=房屋（旧系统地址序）；列=24 个「月应收/收款」+2 个合计（横向滚动、首列 sticky）；小计/合计；金额 2 位小数，收缴率 `#0.00%`。

**下钻**：房屋行 → 该户逐笔（P1 逐笔端点）；汇总行 → 房屋明细。

**筛选**：统计年份、管理处✓、楼栋/门牌✓、收费项目✓、房屋性质✓。

**实测（2026-11-09）**

汇总（2026 年度，按管理处；应收=所属年月 2026，已收=归属 2026 的已收）：

```sql
SELECT b.office_code AS office,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0) AS receivable_cents,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NOT NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0) AS paid_cents,
       ROUND(100.0 * COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NOT NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0)
             / NULLIF(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0), 2) AS rate_pct
FROM mis_mirror_bill b GROUP BY 1 ORDER BY 1;
```

实测：

| 管理处 | 应收（分） | 元 | 归属已收（分） | 元 | 收缴率 |
|---|---:|---:|---:|---:|---:|
| 01 | 172,533,960 | ¥1,725,339.60 | 107,879,970 | ¥1,078,799.70 | 62.53% |
| 02 | 182,957,320 | ¥1,829,573.20 | 110,239,200 | ¥1,102,392.00 | 60.25% |
| 03 | 220,343,200 | ¥2,203,432.00 | 114,369,960 | ¥1,143,699.60 | 51.91% |
| 04 | 764,566,200 | ¥7,645,662.00 | 662,436,700 | ¥6,624,367.00 | 86.64% |

> 同一份数据还有「按收款日期年」口径（2026 年收 2026 年及以前账）：01 102,432,870；02 86,498,010；03 95,459,940；04 655,528,700 分（实测）。**两口径差异 = 跨年补缴/预收**，截图必须确认旧系统用哪个。

明细样例（管理处 02，2026，应收前 5 户）：

```sql
SELECT b.s_id, MAX(b.address) AS address, MAX(b.owner_name) AS owner,
       ROUND(MAX(r.area_sqm)::numeric,2) AS area_sqm,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0) AS 应收,
       COALESCE(SUM(b.amount_cents) FILTER (WHERE b.refund_date IS NULL AND b.paid_date IS NOT NULL AND substr(b.period,1,4)='2026' AND b.amount_cents>0),0) AS 已收
FROM mis_mirror_bill b LEFT JOIN mis_mirror_room r ON r.s_id=b.s_id
WHERE b.office_code='02' GROUP BY b.s_id ORDER BY 应收 DESC LIMIT 5;
```

实测（分）：

| 地址 | 业主 | 面积㎡ | 应收 | 元 | 已收 | 元 |
|---|---|---:|---:|---:|---:|---:|
| 宝秀路701号701 | 陆乾一 | 630.98 | 2,072,160 | ¥20,721.60 | 255,000 | ¥2,550.00 |
| 宝秀路723-725号723-725 | 杨凤林 | 344.37 | 991,680 | ¥9,916.80 | 0 | ¥0.00 |
| 永德路228弄25号1003 | 石文明 | 127.78 | 926,240 | ¥9,262.40 | 926,240 | ¥9,262.40 |
| 永德路228弄21号1101 | 盛爱民 | 151.89 | 757,200 | ¥7,572.00 | 411,000 | ¥4,110.00 |
| 永德路228弄32号1201 | 陈惠峰 | 175.70 | 730,560 | ¥7,305.60 | 330,000 | ¥3,300.00 |

**需用户截图核对的点**（旧系统：`统计汇总 → 收缴考核`）
1. 选择统计年份 2026、管理处 02、收费项目全选，截图整表：月份列结构、合计应收/合计已收、收缴率显示位置。
2. 「按金额」与「按应缴户数」两种收缴率的公式与切换方式。
3. 已收归属：按「所属年月」还是「收款日期」；「收款截止日期」参数是否影响已收。
4. 迁出户是否计入应缴户数。
5. 上半年/下半年分页打印规则。

**已可做/缺镜像**：已可做；缺业主「说明（迁出/新进户）」字段（影响按户数收缴率的分母），建议补 `室表/业主表` 对应列（P3）。

---

## 5. P2 实现顺序与复用/改造清单（原设计计划，非当前执行清单）

> 以下工期、拟新增路由和「先做」顺序属于 2026-11-09 在制方案。多数能力后来已实现且路由命名不同，不能照单重新建设；应以 §3 和附录 E 重新分派，复用现有服务。P1 不受旧「统一净额」建议影响，当前前后端专项回归由各自负责人完成。

### 5.1 原前置方案：退款/调整分块（主要 P2 接口已修正，旧月趋势另查）

1. 修正退款/调整判定（§2.2）：`refund_date IS NOT NULL` = 退款标记行；`amount<0 AND refund_date IS NULL` = 负调整；成对负数行只计一次。
2. 定义两套实收口径常量（`received_flow` / `effective_net`），报表显式声明用哪套。
3. 金额/日期/管理处/性质/权限全部复用 P1 `statistics.util.ts` 常量与 `resolveStatisticsOffices`。

### 5.2 建议实现顺序（1 人约 8–10 个工作日）

| 序 | 报表 | 依赖 | 工作量 | 说明 |
|---:|---|---|---|---|
| 0 | 口径修正 + 单元测试 | — | 0.5d | 修 `collection.service.ts` 退款逻辑，补测试断言（见 §6） |
| 1 | 收费汇总 | 0 | 1d | 后端 `groupBy=office/fee/nature` 三块；前端矩阵 |
| 2 | 收款日报表 + 日常收费项目收款日报表 | 0 | 1d | 共用「行×列矩阵」组件（行=日期，列=收费项目/收款方式/管理处） |
| 3 | 收款汇总表（近似版） | 0 | 1d | 复用 collection/summary；票据/收入列标缺镜像 |
| 4 | 欠收与溢收汇总 | 0 | 1.5d | 两页签 + 房屋明细 + 逐笔下钻 |
| 5 | 收缴考核 | 4 的部分聚合 | 1.5d | 行=房屋，月×应收/收款，合计/收缴率，汇总层 |
| 6 | 收款分析 | 4 | 1d | 按户 LNQ/DNQ/DY/YJ + 区间实收 |
| 7 | 月报表（收费月报表 28 列） | 0 + 截图 | 2d | 需改 P2-A `/statistics/monthly` 模板或新增接口 |
| 8 | 综合月报表B（33 列） | 截图 | 2d | 统计维度（小区/门牌/室号）；街坊/车库维度挂起 |
| 9 | 综合月报表C / 分等综合月报表 | 用户确认 | — | 挂起（C 定义未知；分等缺数据） |

### 5.3 复用 P1/P2-A 清单

| 可复用 | 位置 | 用法 |
|---|---|---|
| 管理处/性质/收费项目常量与范围收敛 | `apps/api/src/modules/statistics/statistics.util.ts` | 全部报表 |
| 镜像水位/available/message | `statistics.service.ts#mirrorState` | 全部报表 |
| 三级下钻（年度→房屋→逐笔） | `/statistics/annual/detail`、`/annual/detail/bills` | 收费汇总/收款汇总/欠收/收缴考核/收款分析 |
| 日期区间校验（≤366 天、非法日期 400） | `collection.util.ts#validateCollectionDateRange` | 收费汇总/日报/收款汇总/收款分析 |
| 分组标签/矩阵拼装 | `collection.util.ts#buildCollectionDailyReport/#buildCollectionMonthlyReport` | 日报/月报改造 |
| 实收/退款/调整三值聚合 | `collection.service.ts#buildSummarySql` | 收费汇总/收款汇总 |
| 金额格式化/CSV（UTF-8 BOM）/下载 | `apps/neighbor-web/src/lib/statistics.ts#fmtCents/annualCsv/downloadCsv` | 全部导出 |
| 筛选面板/矩阵表/下钻抽屉 | `components/statistics/StatisticsFilters.tsx`、`AnnualSummaryTable.tsx`、`HouseDetailSheet.tsx` | 全部前端 |
| 权限 + 数据范围 | `business:view` + `scopeCommunityIds` | 全部 |

### 5.4 改造点（按文件）

- `apps/api/src/modules/statistics/collection.service.ts`：修退款判定（§2.2）；summary 增加 `natures` 过滤（已有）与 `groupBy=nature`；新增：
  - `GET /statistics/collection/matrix?rowDim=date&colDim=fee&...`（收款日报/日常日报共用）
  - `GET /statistics/collection/book?asOfPeriod=YYYYMM&...`（收费月报表 28 列）
  - `GET /statistics/arrears-overpaid?asOfPeriod=&paidDateTo=&...`（欠收/溢收，两 tab）
  - `GET /statistics/collection-rate?year=&...`（收缴考核，行=房屋/管理处）
  - `GET /statistics/collection-analysis?asOfPeriod=&dateFrom=&dateTo=&...`（收款分析 LNQ/DNQ/DY/YJ）
  - `GET /statistics/composite-monthly?asOfPeriod=&dim=office|building|room&...`（综合月报表B）
- `collection.util.ts`：新增 `buildCollectionMatrix`（通用行列矩阵）、`rowKindOf`（R1–R5 分类）、退款/调整口径纯函数 + 单测。
- `dto.ts`：新增上述查询 DTO（复用 `toCodeList`、`PERIOD_RE`、`DATE_RE`；`asOfPeriod`、`dateFrom/dateTo`、`periodFrom/periodTo`、维度枚举校验）。
- `apps/neighbor-web/src/lib/statistics.ts`：新增报表目录项（PENDING_REPORTS 里 11 项改可点）、每报表 CSV 列头。
- `pages/Statistics.tsx` + `components/statistics/`：报表切换（左侧报表树）、矩阵组件支持列固定/横向滚动/合计行、下钻串联、空/错误/数据截止时间。
- `statistics.module.ts` / `statistics.controller.ts`：注册新 service 路由（P2-A 已在改，注意合并不冲突）。

---

## 6. 验收基准（可直接写成测试断言）

数据截止：镜像 2026-11-09 23:15 +08。金额单位：分。

| 编号 | 条件 | 期望值 | 覆盖报表 |
|---|---|---:|---|
| A1 | 收费汇总：管理处 02、2026-10、全部费项/性质 | 收款块 15,374,220；退款块 15,000；调整块 -60,000；净额 15,314,220 | §4.1 |
| A2 | 收费汇总：管理处 02、2026-10、管理费 | 净额 11,915,220（nature01） | §4.1 |
| A3 | 收费汇总：管理处 02、2026-10、泊位费 | 收款块 3,105,000，退款 15,000，调整 -60,000，净额 3,045,000 | §4.1 |
| A4 | 收款汇总表：管理处 02、2026-10、按收款方式 | 现金 1,550,820；微信 9,296,700；支付宝 2,187,900；转账 2,278,800；合计 15,314,220 | §4.2 |
| A5 | 收款汇总表：全部管理处、2026-10、按收款人 | 赵丽萍 46,508,500；刘微微 34,797,740；伍庆中 12,007,200；合计 93,313,440 | §4.2 |
| A6 | 收款日报表：管理处 02、2026-10-01~10-10、按收款方式 | 合计 510,000 / 111,000 / 150,000 / 74,460 / 703,680 | §4.3 |
| A7 | 月报表：统计年月 202610 | 月应收 112,172,140；月调整 -831,370；本期实收 93,313,440；预收转入 32,825,140；预收余额 140,948,070；当月欠收 52,988,490；累计欠收 288,620,240 | §4.4 |
| A8 | 综合月报表B：2026 年按月净实收 | 1 月 117,735,630 … 10 月 93,313,440；1–11 月合计 929,950,200 | §4.5 |
| A9 | 收款分析：管理处 02、截至 202610、宝秀路701号701 | 当年欠收 1,514,300；当月应收 166,430；预缴 90,000；区间实收 15,000 | §4.8 |
| A10 | 日常收费项目收款日报表：管理处 02、2026-10-09 | 管理费 119,460；泊位费 -45,000；合计 74,460 | §4.9 |
| A11 | 欠收与溢收汇总：截至 202610、按管理处 | 欠收合计 288,620,240；溢收合计 161,537,370 | §4.10 |
| A12 | 欠收明细：02、永德路228弄3号402/泊位费 | 201404-202011，16 个月，1,582,500 | §4.10 |
| A13 | 溢收明细：02、永德路228弄33号1202/管理费 | 202611-202712，14 个月，523,180 | §4.10 |
| A14 | 收缴考核：2026 年度按管理处（归属口径） | 01 172,533,960/107,879,970/62.53%；02 182,957,320/110,239,200/60.25%；03 220,343,200/114,369,960/51.91%；04 764,566,200/662,436,700/86.64% | §4.11 |
| A15 | 全库口径自检 | 行 648,041；未缴 14,095 行 400,203,920；退款行 280（正行合计 3,887,420）；负调整 1,316 行 -67,620,290 | §1/§2 |
| A16 | **P2-A 回归（修正后）** | 管理处 02、2026-10：收款 15,374,220、退款 15,000（不是 30,000）、调整 -60,000、净额 15,314,220 | §2.2 |

> 每个单元格/合计都必须满足：汇总 = 下钻明细合计（P1 已有同源校验方式），不允许前端自算。

---

## 7. 需要用户提供/确认的清单（按优先级）

**P0（阻塞旧模板补齐/验收，不阻塞所有本地工作，也不阻塞已验收 P1）**
1. `统计汇总 → 月报表`（2026-10，全部管理处）整表截图：两层表头全称 + 合计行。
2. `统计汇总 → 综合月报表B`（统计年月 2026-10，按小区）33 列完整表头 + 一行数据。
3. `统计汇总 → 收缴考核`（统计年份 2026，管理处 02）表头与「按金额/按户数收缴率」截图。
4. 仅对**尚未定口径的 P2/P3 旧表**，用有退款年份逐张对照日期/金额；不能拿「任一实收表」推导全部报表，更不能据此重开 P1.3 年度验收。历史 2011 退款数字只作截图取样线索。
5. `统计汇总 → 欠收与溢收汇总` 两个页签完整列头（含「说明」列）。
6. 确认「综合月报表C」是否存在/在哪个菜单（本库菜单快照无 C）。

**P1（模板确认，可先实现核心列）**
7. `收费汇总`：退款块位置、笔数是否含负调整、「其他收费」是否显示。
8. `收款汇总表`：「金额/收入」列结构、票据列、收费类别小计。
9. `收款日报表`：列头（收款方式/收费项目）、退款列、三种统计方式差异。
10. `收款分析`：LNQ/DNQ/DY/YJ 中文列名、排序、是否有租赁户页签。
11. `日常收费项目收款日报表`：16 列是否全显示、无收款日是否显示。
12. `分等综合月报表`：确认是否还需要、分等标准配置在哪（本库为空）。

**P2（数据确认）**
13. 泊位费/临时停车费行 `nature_code` 为空时，旧报表「按房屋性质筛选」是否排除（影响很大）。
14. 收款方式为空的那 1 行（zj_id=440090）旧系统如何归类。
15. 管理处 05 馨香北桥-二期是否需要接入（PMS 无同名小区，且无流水）。

---

## 8. 镜像 / 源数据 / 类别 / 模板缺口（2026-11-10 源码校正）

| 需求 | 当前已有 | 真正剩余 / 影响 |
|---|---|---|
| 记账/调整/变动日期 | 收款/退款日期已镜像 | 所检查账单投影未见 `ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq` 三日期；影响旧月报、欠收/溢收精确复刻，历史非空 31/33/10 行不是当前规模 |
| 收入/税额/票据关联 | 账单收入/票据字段已选取，开票行金额/税额已有；收款汇总已有独立开票块 | 不是「补一列即可全完成」；还需核验旧源并集、关联、去重及含税/净额定义。聚合后的房屋×期次记录仍可能没有逐票号码，不能拿镜像字段存在推导所有下钻都有票号 |
| 票据类 | 票据、开票行、票据核销三镜像已有，`ticket-items` 本地已验证 | 领用/库存/使用数量未证明覆盖；未发布部分待授权；开票不等于收款，不把源全部开票行称有效净开票 |
| 签报/减免 | 两类基础镜像、查询 API、页面已有 | 流转过程及旧签报关系是否完整仍须证据；原 01 欠费差异不能继续当当前减免缺失结论 |
| 统计费项类别 | `SETUPSFXM.收费类别` 已镜像为 `fee_item.category`，前端已有类别排序/分组 | 「日常收费」入口是否应自动限定该类别、默认全选及旧小计仍待确认；不要混同收费大屏的 `property/berth/parking/other` 映射 |
| 能耗抄表 | 当前所查统计路由无三张能耗报表 | 抄见数、表具/单位/期间镜像和旧图表定义待补；不是仅加菜单 |
| 空置/出租状态 | 房屋基础镜像已有 | 所查 room 投影无空置/出租状态；历史相关源表空，不代表能自行推算实时空置 |
| 月报/综合月报/分等 | 11 核心指标月报已有 | 完整 28/33 列与 `pendingColumns`、街坊/车库维度、WYDJ/分等标准等仍缺；分等历史源数据为空需用户确认，不造数 |
| 收缴考核/租赁户 | 当前按户指标与考核已有 | 旧户数分母的新进/迁出/进户日期、租赁户 `ZL_ID` 与页面模板需进一步确认 |
| 线上收费 / 应收销账 / 收费标准 | 没有对应独立统计入口 | 各自先定源数据和语义；票据核销不可代替应收销账，分等空表不可代表所有普通收费标准均不存在 |

证据投影与接口见 §0.4；未查到不等于已证明全库不存在。`WYZQ/WYSZ` 在历史快照为空，仅在**相应数据源成功同步且空表可证明**时显示真实 0；未接入/未同步仍应 `available:false`、未知金额 null/「—」，不能用历史空表伪造当前 0。

---

## 附录 A：实测方法与 SQL 记录

**环境（2026-11-09 23:15–23:40 +08，只读）**

```bash
ssh -i ~/.ssh/pms_repair_key.pem ubuntu@124.223.179.214
sudo docker exec -i pms-postgres psql -U pms -d pms_repair -X -P pager=off
# 只执行 SELECT / \echo / \timing；未执行任何 INSERT/UPDATE/DELETE/DDL
```

- 服务器：`VM-4-8-ubuntu`（124.223.179.214，私网 10.0.4.8），PostgreSQL 16.15。
- 镜像水位：`mis_sync_state`（source_table=bill）最近成功 **2026-11-09 23:15:00 +08 / 15:15Z，synced_rows=648,782**。
- `mis_mirror_bill` 仅有主键索引 `mis_mirror_bill_pkey(zj_id)`；全表聚合约 **110ms**（实测 T1 111.6ms、T2 108.7ms）；单页 5–10 条聚合 SQL 的报表接口性能可接受，无需额外索引（若需，可加 `(office_code, paid_date)`、`(paid_date)` 部分索引，但先不做）。

**本文件引用的实测 SQL 均直接粘贴自执行文件，未改写逻辑；文中所有数字为实际返回。** 查询清单：

| 编号 | 用途 | 返回行数 |
|---|---|---:|
| A1–A8 | 数据底座（行数/管理处/收费项目/方式/收款人/性质/水位） | 1–10 |
| B1–B11 | 退款/负数/预收/未缴/月度净额 | 1–77 |
| C1–C8 | 退款成对/地址明细/负行分类 | 1–24 |
| D1–D3 | 退款凭证行/2026-10 退款明细/退款合计 | 1–19 |
| Q1–Q11 | 收费汇总/收款汇总/日报/月报/综合B/方式占比/欠收溢收/收缴率/实收两口径/日报费项/镜像字段 | 1–12 |
| Q12–Q19 | 月报指标初版/收缴考核明细/欠收明细/溢收明细/收费汇总×性质/收款汇总×方式/退款年/月度两口径差 | 1–12 |
| Q20–Q25 | 日报×方式/收款分析/行分类/月报指标修订/未缴拆分/空方式行 | 1–6 |
| T1–T5 | 性能与索引、水位 | 1–11 |

**旧系统定义核对脚本**（只读本机文件，不执行旧软件）：`D:\一通MIS\物业管理.exe` 的 UTF-16LE 字符串提取（Python 只读 `open(...,'rb')`）；MIS 菜单来自 `outputs/mis-db-sync-20261106/data/0020_dbo.ApplicationModule.csv`（只读 CSV）。

---

## 附录 B：旧系统 EXE 证据索引（`D:\一通MIS\物业管理.exe`，2026-11-09 只读）

| 报表/窗体 | 字符串 offset | 关键证据 |
|---|---:|---|
| 收费汇总 | 993400 / 993456 / 994412 / 994712 | 收款 SQL（ZJ_SKRQ 区间、GROUP BY ZJ_LX,FWXZ_DH）、退款 SQL（ZJ_TKRQ）、其他收费 WYZQ/WYSZ、筛选提示 |
| 收款日报表 | 1180040 / 1180180 / 1180616 / 1180719 | 表单标题、管理处/收款方式字典、日期范围、不分部门/按部门/按管理项目 |
| 收费月报表（月报表） | 961120 / 961396–962400 / 963304 | A1:AB8 模板、28 列两层表头、编制单位/单位金额元、WYZJ+WYDJ SQL |
| 综合月报表B / 营改增 | 1335464 / 1329814 / 1332744 / 1316196 | 33/34 列表头、公式说明、综合月报表.INI、统计维度（小区/街坊/门牌/室号/车库/车主） |
| 分等综合月报表 | 967620 / 965822 / 966440 / 966992 | 表单标题、分等收费标准明细 join、WYDJ.分等标准、错误提示「不是分等收费项目或没有设置分等收费标准」 |
| 收款分析 | 957040 / 957270–957800 | LNQ/DNQ/DY/YJ 聚合、统计日期范围、按户/按租赁户 |
| 欠收与溢收汇总 | 1585265 / 1587091 / 1588379 / 1590487 / 931140 / 935304 | 欠收统计/溢收统计标题、明细列头（欠费年月范围/月份数/金额、收费年月范围…）、汇总 SQL（记账/变动日期条件） |
| 收缴考核 | 952946 / 949180 / 951588 / 952920 / 953460 | 收缴情况统计、12 月×应收/收款列头、按金额/按应缴户数收缴率、月份区间 SQL |
| 收款汇总表（收款汇总统计表） | 1374244 / 1378768 / 1380720 | 表单标题、票据开票数据汇总、收入(不含税) SQL、明细列 |

---

## 附录 C：原 P2-A 差异的当前处理状态（2026-11-10 本地审计）

| 接口 | 当前源码 / 剩余 |
|---|---|
| `GET /statistics/collection/summary`、`collection/detail` | 主要收款/退款/调整已分块，不能继续引用 11-09 在制代码说它们一概成对双计；复用现有 API，不重造 |
| `GET /statistics/daily` | 当前业务日期×费项正收款，退款/调整另列；两日报共用，分类/合计下钻和仅退款调整日已合入未发布，旧模板/日常类别仍待核验 |
| `GET /statistics/monthly` | 仍是月×费项旧接口，使用 P2-A 旧净额逻辑，需本地测试/整理调用与命名；它不是当前前端 `monthly-report` |
| `GET /statistics/monthly-report` | 管理处×11 项核心财务指标与待确认列已有；旧 28 列和综合 B/C 不因此完成 |

实现依据：[collection service](<apps/api/src/modules/statistics/collection.service.ts#L90-L97>)、[日报/旧月报](<apps/api/src/modules/statistics/collection.service.ts#L353-L467>)及[核心月报](<apps/api/src/modules/statistics/analysis.service.ts#L279-L429>)。原附录 C 的「所有 P2-A 均未提交/全部退款双计」描述已过时；本轮未改任何源码或他人工作区。

---

## 附录 D：P4-B 开票统计接口与页面（2026-11-10，未发布）

使用既有 `mis_mirror_ticket_item JOIN mis_mirror_ticket`，不新增镜像、不写业务表；权限 `business:view`，管理处始终按当前租户的小区权限收敛。

| GET /statistics 下路径 | 查询与结果 |
|---|---|
| `ticket-items/summary` | `groupBy=fee/office/day`；日期、管理处、费项多选；行含明细行数、去重票据张数、金额/税额/不含税收入（整数分）；合计单独 COUNT DISTINCT，不累加各组张数 |
| `ticket-items/detail` | 同上筛选，另有 `ticketNo` 精确匹配、`keyword` 匹配票号/入库单/发票号/品名/费项代码；默认 200 行、最多 500，分页不影响合计 |
| `tickets/:id/items` | 当前权限内票据摘要及全部开票行；不存在或越权统一 404；镜像未同步返回 available:false、totals:null，而非假 0 |

- 日期按票据 `issue_date`，包含起止当天，支持任一单侧日期或不传日期。双侧日期沿用其他日报的最多 366 天差限制；查询全部历史可不传日期。
- 不默认剔除作废/预开/核销票据，本轮统计明确为源镜像所有开票行口径，不称作实际收款或有效净开票。
- 税额取开票行，收入=金额−税额，保留源负数。`coverage` 动态返回授权管理处/所选费项下镜像开票日期范围、行数/张数、非零税额行数、未知税额行数；不随日期/关键词缩小，前端不得硬编码 2022–2023 或「税额全部为 0」。
- `dataAsOf` 取票据和开票行水位的较早值。空镜像未同步返回 available:false；有成功同步水位的空表才可返回真实 0。
- 住户检索复用 `tickets`，关键词已有票号/付款人/地址/发票号，补充 `customer_name`（住户名称）。住户票据查询不是已确认的旧统计菜单项，暂不额外启用该菜单，逐票明细可先接现有「票据情况统计」。
- 回归 `test:statistics-p8`：小型多费项/负数/非零税额夹具验证计算、分页、筛选、范围收敛、404、DTO和权限；597 行/588 票夹具仅为聚合基准合成数据，**不是生产原始明细**。
- 上一轮只读核对的生产基准：597 行/588 票，117,484,580 分，税额 0，日期 2022-11-25 至 2023-12-23。本轮未连接生产，不能据此宣称生产接口已验收。
- 验证：API typecheck exit 0；同一 Node 进程加载统计 P1–P8 的全部 11 个测试文件，88/88 通过（新增 P8 7/7）。其中镜像同步超时 WARN 是既有故障隔离夹具预期输出，测试通过；无生产操作。未做发布构建与公网验收。

### 前端接入与验收边界

- 正式代码入口 `/statistics` 启用「开票数据统计」：管理处/收费项目多选，开票日期默认全部历史，支持单侧日期；重置恢复全历史；无房屋性质筛选。按收费项目/管理处/日期分组，三个金额列均下钻；缺失分组 key 不误钻全部数据，可从独立合计查看全部明细。
- 明细默认每次200行，票号精确/关键词筛选独立应用；合计是全部匹配行而非当前页。CSV导出先取完剩余页，日期/费项/管理处使用已应用快照；数据水位、count或合计发生变化则中止，不下载混合结果。抽屉关闭/切换后的迟到响应被隔离。
- 「票据情况统计」票号新增逐票明细入口，读取当前授权票据摘要与全部开票行；不新建未经确认的「住户票据查询」菜单。
- 汇总/逐笔CSV均有UTF-8 BOM；公式式文本加单引号，负金额保持数值。前端收到null的逐行金额/税额时显示「—」、导出留空（后端当前聚合仍沿用COALESCE，源未知税额由coverage单独披露）；覆盖提示仅在行数>0且非零税额行数、未知税额行数均为0时声明全零。镜像未同步显示message且禁导出，不假造0。
- 浏览器夹具为隔离合成数据（201行、2张票跨费项，含负数及CSV公式攻击文本），不是生产数据。覆盖分组、精确下钻、独立总计、分页/全量导出与水位变化中止、逐票、日期验证/单侧/重置、旧响应隔离、错误重试、等待、未同步、1440/390/320宽度与内部滚动。
- 截图：`D:/pms-statistics-evidence/statistics-ticket-items-1440.png`、`statistics-ticket-items-detail-1440.png`、`statistics-ticket-items-detail-390.png`、`statistics-ticket-items-detail-320.png`、`statistics-ticket-items-320.png`，另有loading/error/逐票截图。只证明真实Chromium中的生产组件+合成API传输，不代表生产接口或公网验收。
- 前端typecheck通过；新增P4-B定向回归2/2通过，最终完整统计浏览器回归16/16通过（138531ms）；前端提交`b69a911b`已合入并推送main后，本地`tsc --noEmit && vite build`通过（14.74s，只有>500KB分块提示）。构建前端源码无未提交改动，其他任务的API/文档WIP保持原样，未上传构建产物。本轮不连接、不修改、不发布生产，须获当次明确授权后再上线。

---

## 附录 E：剩余工作、全局 TODO 校正与建议（2026-11-10 独立审计）

### E.1 审计范围与立即可做项

本轮读取[项目约定](<CLAUDE.md>)、本报告、[统计 spec](<docs/statistics-reports-spec.md>)、[全局交接 TODO](<docs/session-handoff-2026-11-09.md#L89-L126>)及相关前后端源码、旧菜单 CSV 和本地部署标签。**本轮只做文档审计，未运行功能测试、浏览器或生产命令**；历史测试/上线数字的来源和身份见 §0.4、§4.9、附录 D。任务板由 Lead 管理；审计子会话无任务板接口，仅按初始委托执行，未声称读取任务板。Lead 已对照 task-43 原文复核本节与旧 30 项映射并验收文档交付，此工具限制不是业务阻塞。

**目录对账已由 Lead 本地完成**：据 §3 为遗漏的销账/物业收款/明细/三项能耗/标准/四项专用欠溢旧表补齐 11 项灰字身份，当前 17 个可选入口、18 个待接入标签（15 项旧专用身份 + 3 项额外待接入），不是 35 张旧报表已实现。旧 30 项黄金映射回归先红（6/7），修后纯函数 7/7；与票据及旧接口兼容契约合跑 12/12。不改年度算法，不造假按钮/流水；截图与旧模板验收缺口仍保留。源码见[待接入目录](<apps/neighbor-web/src/lib/statistics.ts#L407-L428>)，测试见[菜单契约](<apps/neighbor-web/test/statistics-contract.test.cjs>)，尚未生产发布。

[received.hint](<apps/neighbor-web/src/lib/statistics.ts#L388>)初读仍误写「按收款日期年度」；交付前复读已由并行工作改为「按应收年月所属年度汇总已收流水（含退款标记行及负调整）」。Lead 已增加[纯函数契约回归](<apps/neighbor-web/test/statistics-contract.test.cjs>)：旧提示先红（5/6），修正后 6/6 通过；同时验证年度/下钻筛选一致与分类金额未知≠0。不再重复安排修文案；这是本地证据，未发布。

- 三类明细与年度 GPT 已分别交付，Lead 已验收：明细浏览器 29/29（最新 CSS 另复验其中 11 项，不相加），年度 37/37；整合票据修复后 Lead 独立重跑完整后端 P1–P8 **103/103**（110493ms，exit 0）。类型检查通过。这些为本地合成/PGlite 证据，不代表旧全部模板或生产验收；详细[明细证据](<D:/pms-statistics-evidence/gpt-detail-acceptance.md>)。
- 票据 GPT 已补回归并修复 `ticket-summary`：缺任一票据表/未同步，票据金额/税额/收入/张数行及总计为 null，独立 readiness/水位；收款和收款人真实数据保留。已同步空表/无匹配为真实 0；UI/CSV 区分未知、陈旧零与真零。原 CSV 只导出收款主表，本次追加票据/收款人独立块，不能误报「修复原票据 CSV 假零」。API 新增 7 项先红后绿、P7 11/11 + P8 7/7，GPT 前端新 4/4；Lead 又补 1 项先红后绿的旧 API 兼容回归，带未同步告警或 partial 的占位零仍未知，无告警旧数值响应的真零继续兼容，现 5/5（与菜单契约合跑 12/12）。Lead 用最终源码重验 1440/390/320 的 18 场景（含真实导出 Blob）通过；[专项报告](<.tmp/gpt-ticket-summary/REPORT.md>)。未改新 `ticket-items` 算法。
- 旧 `/statistics/monthly` 仍有显式 P2-A 兼容净额逻辑；Lead 本地仓库检索只见控制器/测试，正式统计页调用的是 `/statistics/monthly-report`。外部调用者及兼容退役要求未确认，不能未经确认删接口/改为年度流水口径，也不把此接口冒充新版完整月报。

### E.2 全局交接中已过期与仍成立的项目（仅转 Lead，不扩展实施）

| 全局条目 | 本轮核对结论 / 边界 |
|---|---|
| 01 欠费多 ¥232,344.20、待补票据/减免找原因 | 旧 TODO 已过期：后续 P1.1/P1.3 已完成行级性质与 06 排除验收；不要据此重开年度算法或把空置当性质 06 |
| 「P2-A 全未发布、退款都双计、全部实收 A/B 待定」 | 被后续 P2-B/E 历史上线与 P1.3 验收部分覆盖；只保留具体旧接口和未发布新增项，不把新旧整包混为一谈 |
| 收费报表只统计 PMS、MIS 无数 | 已过期：[收费服务](<apps/api/src/modules/fees/fees.service.ts#L497-L617>)已合并 MIS，存在明细/来源互斥和 cashier 分组；[交接时间线](<docs/session-handoff-2026-11-09.md#L47>)记载 09:33 历史发布。不是本轮现网验证 |
| 门禁 .80/.88 还停 2.5.50、未升级 | 旧 TODO 被[10:26 版本记录](<docs/session-handoff-2026-11-09.md#L35-L40>)的两现场 2.5.52 覆盖。不能重复报「全部未升级」，也不能推导设备刷卡/远程写卡全通过；[历史行映射](<apps/api/src/modules/access-card-issuance/legacy-card-history.util.ts#L48-L64>)仍区分旧助手缺字段，具体能力/设备回执需现场授权验证 |
| 上海新家目标/12 个月分解/大屏 other 分类 | 业务金额与分类仍待用户确认，不能造指标；并非缺分月能力：[目标工具](<apps/api/src/modules/fees/collection-targets.util.ts#L20-L55>)已支持 12 月值，[大屏](<apps/api/src/modules/fees/screen-summary.util.ts#L20-L24>)显式值优先、空月才年度/12。当前配置未查生产 |
| MIS Phase 3 断线收款/核销/差异页 | [设计 Phase C/D](<docs/mis-mirror-design.md#L496-L512>)仍是独立闭环要求；本轮检索未见设计名 `pms_mis_receipts` / `pms_mis_collection_differences`，账单页未见所述差异 tab。但已有[收款写回控制器](<apps/api/src/modules/fees/mis-posting.controller.ts>)及[幂等/重试服务](<apps/api/src/modules/fees/mis-posting.service.ts>)，不能称「完全没有收款写回」，也不能以它替代离线本地收款→恢复核对→差异处理→去重统计的完整验收。需独立专项，不在统计审计中实现 |
| 库存历史库位、通知单用语、小程序体验/扫码、并行大屏 WIP、业务动作覆盖测试 | 交接仍列待办；本轮不扩展源码/现场处理。尤其「9 条失败」只是历史记录，本轮未跑[业务动作覆盖测试](<apps/api/src/modules/observability/business-action-coverage.test.ts>)，不声称当前仍红或已绿 |

### E.3 精炼剩余工作表（不是完成清单）

| 范围 | 本地可继续做 | 真正外部阻塞 / 完成证据 |
|---|---|---|
| 目录对账 / P1 文案状态 | 已补灰字遗漏，17 可选/18 待接入；hint 已修，**不改 P1 算法** | 旧 30 黄金映射/提示/筛选契约 7/7，合并票据及旧接口兼容契约 12/12；灰字不等于模板已实现，未发布 |
| 当前专项回归 | 年度、三类明细、票据未知值 GPT 已交付 | Lead 全后端 103/103；最终统计前端 43/43（浏览器脚本 31 + 独立契约 12）、typecheck 通过；票据最终源码 18 场景通过。新增全宽/顶部抽屉五宽共 311 帧实测几何/滚动变化 0px；[最终验收与构建记录](<.tmp/gpt-stats-layout/LEAD-ACCEPTANCE.md>) |
| 未发布日报/开票新增 | 源码与历史本地构建/夹具证据已有，后续按实际源码变更重验 | **当次发布授权**；发布后正式 `/statistics`→API→授权范围/水位/金额/CSV 公网验证，当前未验 |
| 旧月趋势 / 票据块未知值 | 票据已补 7+4 项红绿并修复；旧月趋势本地调用已梳理，非当前正式页面接口 | 旧兼容接口外部调用/退役契约仍待确认，不盲改口径；票据生产部署/水位验证需当次授权 |
| 月报 28 列、综合 B/C 33 列、日报/分析/考核旧模板 | 核心指标及现有筛选/明细继续复用，整理列公式差异 | 需用户旧整表截图/列公式/统计维度；部分日期/街坊/车库等需**镜像扩展与授权**；P1 不受阻 |
| 销账 #4、物业收款 #11、明细 #12、欠/溢 #26–29 | 先整理复用关系和菜单/接口映射，避免平行实现 | 旧语义/分组/日期/销账源关系确认；未获证据不得把共用能力算逐张完成 |
| 日常类别与普通/分等收费标准 #14/#15/#24 | 复用已镜像统计 category；整理普通/分等源差别 | 日常筛选范围待用户确认；分等历史源数据为空、标准/镜像未齐；不能将类别说成普遍缺失 |
| 能耗 #19–21、空房 #13、额外线上/票据使用数量 | 数据源/单位/状态与权限定义可先在本地做设计核对 | **源数据 + 缺镜像**（能耗、空置、领用/渠道等），须获授权后接入/同步；未知不得补 0 |
| 非统计：指标/门禁/镜像 Phase 3 | 只向 Lead 报上述状态与误判，不扩展本轮修改 | 用户目标金额/类别决策；现场能力/设备确认、断线核对与生产操作均另需授权/验收 |

## 附录 F：年度口径与剩余清单复核（2026-11-10，源码 f514cdd3）

- **本轮新增验证**：GPT 独立审计并执行 `node -r ts-node/register --test src/modules/statistics/statistics.util.test.ts src/modules/statistics/statistics.test.ts`（工作目录 `apps/api`），**37/37 通过**。复核管理处授权交集、按应收年月归年、行级房屋性质不回退室表、带符号实收、截止条件及年度→房屋→账单金额守恒；未发现上述范围内可由正常镜像入口触发的新缺陷，不为制造改动而重写 P1 算法。此证据是本地 PGlite 合成数据，不是重新生产对账。
- **修正文档自身的过期现状**：页首、§0.4、§3 已与[实际目录](<apps/neighbor-web/src/lib/statistics.ts#L387-L428>)及[旧 30 项黄金契约](<apps/neighbor-web/test/statistics-contract.test.cjs#L29-L51>)对齐为 **17 可选 / 18 待接入标签**；不再把已补灰字身份的 11 项描述为「目录遗漏」。灰字只证明保留待办，仍未实现其旧专用模板。
- **最近已交付但未部署的交互批次**：`f514cdd3` 已推送 main，包含手动「生成统计报表」、打开筛选不计算、居中等待反馈、主表分页防重/隔离迟到响应，以及当前显示结果单文件格式化 XLSX。浏览器、独立 Excel 解析/实际渲染、类型检查及提交后正式 Web 构建已验证；这里不把合成夹具等同旧系统全量业务验收。
- **本轮读取部署标记**：通过 `node deploy/mark-deployed.mjs status` 获取远端 Git 部署标签后，本地主线为 `f514cdd3`，API 部署标签 `475b21f6`，Web 部署标签 `665a99e8`；分别存在 **4 个 API / 6 个 Web 相关未发布提交**。这是 Git 部署标记检查，不是公网版本/运行服务实测，更不是生产发布。API 打包范围另有无关 telemetry 未提交文件，后续发布不得混入。
- **后续验收仍按具体差异推进**：先取得 #4 销账、#11 物业收款、#12 收退款明细及 #26–29 专用欠/溢的旧筛选/分组/日期语义；月报按 28/33 列逐列补公式证据；能耗与空房先确认源数据/镜像/单位/状态，不能用收费金额或性质 06 冒充耗量或实时空置。沿用现有 API/明细能力，未确认模板不得只换标题宣告复刻完成。
- **目标尚未整体完成**：本轮没有生产发布授权，未部署 API/Web、未重灌镜像、未连接生产/MIS，亦未重验全部旧模板。两张年度表的历史上线验收继续见[年度 spec §7–9](<docs/statistics-reports-spec.md#L167-L206>)；其余逐张报表、最新交互发布及现网验收继续保留待办。

## 附录 G：收退款/普通收费标准的新增本机证据与字段准备（2026-11-10）

### G.1 证据身份与可复核性

- 本机[旧客户端](<D:/一通MIS/物业管理.exe>)仅作为二进制读取，未执行：19,091,456 bytes，SHA-256 `62538e82eb6814c1584c8f43171f6c5bb44b392128c74b4f4b1efe7e549d58bc`。下面全部 offset 是**文件字节偏移**，不是行号或内存地址。字符串池中的 BSTR SQL 与窗体序列化资源分别取证，不把邻近字面量一概视作同一过程。
- GPT 独立提取后，Lead 使用[字节核验脚本](<.tmp/legacy-statistics-round13/verify-evidence.py>)再次校验 **15 个完整字符串锚点、3 个菜单身份、文件长度/哈希**，生成[核验结果](<.tmp/legacy-statistics-round13/lead-verification.json>)。原始文本留在[提取摘要](<.tmp/legacy-statistics-round13/focused-report.txt>)及同目录，均未提交业务源码仓库。
- 特别注意：退款窗体列头在 **1399883（奇数字节位置）**。只对整个 EXE 从偶数位置解码 UTF-16LE 会漏掉它；「某次检索没找到」不等于窗体没有该列。

### G.2 #12 的候选窗体，不冒认菜单映射

- [菜单快照](<outputs/mis-db-sync-20261106/data/0020_dbo.ApplicationModule.csv#L192>)存在 UniqueID=191「收退款明细统计」，商用重复项 ID=332；两种编码 UTF-16LE/GBK 的全文件搜索均未找到该完整标题或「收退款」。**尚未证明菜单 191 调用下面的退款窗体**。
- 已证实同一序列化资源：GBK `frm退款情况统计` @1399280、标题 @1399300；UTF-16LE 列头 @1399883 为：`序 / 地址 / 住户 / 退户 / 项目 / 年月 / 收款日期 / 退款日期 / 退款金额`。同窗体控件为「统计日期」@1400455、「收费项目」@1400528、「管理处(所)」@1400601，另有统计/打印按钮。
- 候选 SQL：@954556 地址/业主姓名；@954940 `ZJ_CNY,ZJ_Tkrq,ZJ_Skrq,ZJ_Je,ZJ_Lx`；@955048 从楼表→室表→业主表→WYZJ，账单按 `ZH_ID` 连业主；@955304/@955684 分别为 `说明='新进户'` / `说明<>'新进户'` 与 **`ZJ_TKRQ Between`**；@955388/@955420 有管理处/费项等值条件。BSTR 标题「退款情况统计」@955824。
- 因而可确认的是**退款日期候选明细**，不能证明完整收退款、按收款日期查询、调整/净额列、多选、总计或正负成对去重。日期默认值、「全部」选项与「退户」显示计算也未恢复。不能只给现有 collection/detail 换标题后宣告 #12 复刻完成。

### G.3 #24 的普通收费标准源已部分确认

- 菜单 ID=448「收费标准汇总」；BSTR 运行标题「收费标准汇总表」@1338344。资源中 `frm收费标准汇总` @1894608，设计时 caption 却为「住户台账」@1894628，不能拿设计 caption 否定实际运行标题。
- 固定列头 @1336128：`序 / 管理处 / 地址 / 姓名 / 业主电话 / 建筑面积 / 房屋性质 / 进户日期 / 开始收费日期`，末尾留动态收费项目列槽；标准小计 @1336320、标准合计 @1338328。
- @1336340 明确 `WYDJ.Histroy = 0 GROUP BY WYDJ.DH,WYDJ.ZH_ID`；@1336616 含业主进户/开始收费日期；@1337108 为当前 `业主表.说明='新进户'` 左连；@1338364 为未终止的收费类别。**不是仅凭空的分等标准明细就能断言普通标准也无来源**。
- 以上是 Round13 的字面量证据；**Round14 已通过命名窗体原生交叉引用恢复 JE 聚合与费项加载顺序，见附录 H**。计费单位、上游归一化和显示分支仍未核定；邻近有员工授权/发票字面量交错，不能移植进来。

### G.4 已实现的是源字段准备，不是两张报表完成

- [新增迁移](<apps/api/src/migrations/1795600000000-MisMirrorOwnerReportFields.ts>)只给 `mis_mirror_owner` 增加可空 `owner_note`、`move_in_date`、`billing_start_date`，没有默认值、推断或自动回填。源字段均由[本地业主快照表头](<outputs/mis-db-sync-20261106/data/1015_dbo.业主表.csv#L1>)确认存在。
- [既有手工全量重灌](<apps/api/src/modules/fees/mis-mirror.service.ts#L473-L501>)按原文保存业主说明；两个日期先在 SQL Server 用 `CONVERT(varchar(10),…,23)` 提取民用日期，避免跨时区偏日。空值保持 null。既有增量账单同步、统计查询、同步频率和权限均不变；不把「说明」映射成实时空置/退户状态。
- [回归用例](<apps/api/src/modules/fees/mis-mirror.test.ts#L41-L105>)先复现旧业主查询漏字段，再验证可重复 up/down、旧行保持未知、保留原数据、三字段落库、空/缺字段和重复重灌更新。镜像及补充镜像 **10/10** 通过，API `tsc --noEmit` 通过；这是本地 PGlite 合成数据，不是现场同步验收。
- **发布前置**：本次未执行生产 SQL、镜像重灌或部署。未来获当次明确授权后，必须先应用这条 ALTER 迁移再使用新版手工重灌，随后核对实际数据；历史行在此之前保持未知。两张菜单仍保留待接入，下一步需要 #12 的菜单到窗体映射/实际截图与 #24 的单位/显示分支证据、WYDJ 精度保真镜像及模板。

## 附录 H：收费标准原生引用取证与重灌失败保护（Round14）

### H.1 从命名窗体绑定代码，不再按字符串邻近归属

- 目标仍为 G.1 中同一旧 EXE，19,091,456 字节，SHA256 `62538e82eb6814c1584c8f43171f6c5bb44b392128c74b4f4b1efe7e549d58bc`；只静态读取，没有执行旧程序。以下均为十进制文件字节偏移；该段 PE32 `.text` 的 `VA = 文件偏移 + 0x400000`，不能推广到其他节。
- GBK `frm收费标准汇总` @923252 → 名称指针 @907920 → 对象描述符 @907896 → 对象信息 @388748（@388772 反指同一描述符）→ @388852 指向事件表 @389476。事件槽 @389484、@389488、@389504 分别经过 JMP 桩 @391174、@391187、@391239，落到统计过程 @17822624、打印/标题过程 @17843440、加载过程 @17846288。
- 统计过程 `[17822624,17843440)` 完整解码 20,816 字节，入口、SEH 帧、`ret 4` @17843422、异常尾块和下一过程序言相符。**这证明同名窗体内的过程关联，不等于已经恢复应用菜单 ID=448 的完整调度链，也不是还原了 VB 源码。**
- 静态复现见[团队取证记录](<.tmp/legacy-statistics-round14/findings.md>)；Lead 用独立标准库脚本核实了对象指针链、3 条 JMP 路由及 16 个带确定指令编码的 BSTR 立即数引用，见[独立验证脚本](<.tmp/legacy-statistics-round14/lead_verify.py>)与[验证结果](<.tmp/legacy-statistics-round14/lead-verification.json>)。未连接 MIS/生产、未安装依赖，也未复制住户明细。

### H.2 已确认的金额表达式、筛选与列序

| 语义 | BSTR 文件偏移 | 同一统计过程中的指令偏移 |
|---|---|---|
| 固定列头（到开始收费日期） | 1336128 | PUSH @17827382 |
| ` (CASE WHEN WYDJ.DH ='` | 1335480 | PUSH @17825320 |
| `' THEN SUM(je)  END) AS [` | 1335020 | MOV 立即数 @17825596 |
| `],` | 1335532 | MOV @17825855 / PUSH @17826601 |
| 外层 ` sum( [` / `]) as  [` | 1335544 / 1331752 | PUSH @17826527 / @17826564 |
| `,WYDJ.ZH_ID from WYDJ where WYDJ.Histroy = 0 group by WYDJ.DH,WYDJ.ZH_ID` | 1336340 | PUSH @17827760 |
| 标准小计 / 标准合计 | 1336320 / 1338328 | PUSH @17827405 / MOV @17838841 |

- 金额源已从未知缩小为 **JE，不是 BZ**：内层按费项代码与业主聚合，动态 CASE 形如 `(CASE WHEN WYDJ.DH ='<代码>' THEN SUM(je) END) AS [<名称>]`；外层再 `sum([<名称>])`。原串没有 `ELSE 0`，不能在未核对空值呈现前自行补零。名称经过 `rtcTrimVar`；动态片段通过同过程的字符串连接累积器组装，不是凭邻近关系拼接。
- 同过程 @17827935 引用 BSTR @1337108，业主左连接仍限定 `说明='新进户'`；WYDJ 明确仅有 `Histroy=0`，没有据此推断 `类型` 或 `分等标准` 过滤，更不能把它命名为「排除分等」的算法。
- 选中收费节点测试 checked=-1 与 `Left(key,1)='X'`，取代码为 `Right(key,Len(key)-1)`：**X 是前缀，不是后缀**。按节点索引 1..Count 正序扫描，表头、内层 CASE 和外层 SUM 来自同一选择循环，不是按点击顺序排列。
- 同窗体加载过程 @17847475 引用 @1338364：活动收费类别 `GROUP BY 收费类别 ORDER BY 收费类别`；@17848476/@17848656 引用 @954132/@1337404：类内活动费项 `终止日期 Is Null Order by Len(DH),DH`。这是名义加载顺序；TreeView 的运行时 Sorted 属性及默认选中仍未验证，不硬编码一份通用费项表。
- 污染排除：邻近「补开全电发票吗？」@1337084 的代码引用在操作数 @18641468，位于本统计过程之外，不归入本表。

### H.3 精度、单位与仍未实现的部分

- [源表结构](<outputs/mis-db-sync-20261106/schema-columns.csv>)及[本地结构摘录](<.tmp/legacy-statistics-round14/source-metadata.txt>)确认 WYDJ.JE/BZ 都为可空 `money(19,4)`；WYDJ.DH 为 nvarchar(2)，Histroy 为可空 bit、默认 0。SETUPSFXM.BZ 却是 nvarchar(500)，不能混同。CSV 只读了字段头，未读取/复制实际住户行。
- 当前报告 SQL 是原始 `SUM(JE)`；未见 `/12`、乘建筑面积或显式月度归一化。**这不能证明 JE 的上游业务单位是元/月或元/㎡/月**，也不能推导 JE=BZ×面积。后续应保留四位源精度，在正确聚合层舍入后再输出整数分；例如同一费项×业主单元格内两笔 0.0049 相加后显示 0.01，不能先逐笔舍入为分再相加；跨费项的小计另遵循附录 I 的格式化后求和，不能混用。
- 截至 Round14，仅发现数值显示格式 `#0.00`、`##,##0.00` 及 IsNull/IIf 调用，WYDJ 镜像、API、UI 模板尚未新增；Round15 的显示分支及原始镜像进展见附录 I。#24 继续灰字待接入，清单仍为 17 个可选 / 18 个待接入，**不是新增一张已完成报表**。

### H.4 手工重灌先检查目标结构，失败不冒充同步成功

- [reloadAll 前置检查](<apps/api/src/modules/fees/mis-mirror.service.ts#L473-L493>)在既有互斥锁内、任何 MIS 查询和维度删除前，执行三列 `SELECT … LIMIT 0`。仅 PostgreSQL 42703（缺列）/42P01（缺表）转为明确 503，提示先应用镜像迁移（含 1795600000000）；权限/连接等其他异常原样抛出，最终仍释放既有锁。没有自动执行 DDL、回填、重试或重灌，没有改变 cron、报表查询或管理员权限。
- [新增回归](<apps/api/src/modules/fees/mis-mirror.test.ts#L106-L184>)先复现旧实现缺迁移仍读取 MIS，再验证提前失败不读源、不改旧镜像、正确解锁，权限异常不被伪装；同时用真实 PGlite 事务故障注入验证源业主读取失败与新日期写入失败后，三张维度、账单及成功水位均保持原样。补充镜像测试夹具应用同一新增迁移，不绕过检查。
- 本轮镜像/补充镜像 **13/13**、API 类型检查通过，独立源码复核 PASS；均为本地合成数据。生产、实际迁移/手工重灌、两张旧表的现场验收仍未进行。

## 附录 I：四位收费标准镜像与显示层合计（Round15）

### I.1 仅建立手工源快照，不提前开放报表

- [新迁移](<apps/api/src/migrations/1795700000000-MisMirrorChargeStandard.ts>)建立 `mis_mirror_charge_standard`：ID/业主/可空租赁 ID 为 bigint，原始费项代码可空，JE/BZ 为可空 `numeric(19,4)`，历史标记可空。没有外键、默认历史状态、金额推断或回填，不删除源孤立/历史/租赁行；活动业主×费项仅有部分索引，报表筛选另做。
- [手工重灌](<apps/api/src/modules/fees/mis-mirror.service.ts#L474-L535>)先检查业主和标准目标列。缺表/列 503 同时提示 1795600000000、1795700000000，其他 PG 异常原样抛出；任何 MIS 读取前失败并解锁。新增 WYDJ 查询**只在既有管理员手工重灌内**，没有加入 cron、字典同步或统计查询，没有新增入口/权限。
- 源 ID/ZH_ID/ZL_ID 先 `CONVERT(varchar(20),…)`，JE/BZ 必须 `CONVERT(varchar(40),…,2)`：SQL Server money 默认字符串风格仅两位，**style 2 才保留四位**。[传输校验](<apps/api/src/modules/fees/charge-standard-mirror.util.ts>)拒绝 JS 数值 ID/金额、缺列、非四位金额、超 money 范围和伪布尔；原始 null、零、负数分别保留。不以分为单位逐源行舍入，也不赋予月度/面积单位。
- 必须有真实数组结果集；缺失结果集不是成功空表。源读完并通过校验后，楼/室/业主/收费标准的替换与 `charge_standard` 成功水位在**同一个 PostgreSQL 事务**中完成；重复 ID 等落库失败整体回滚这四张表和该水位。有效空集则提交零行快照并初始化水位，区别于从未重灌。迁移本身不初始化水位，回退删除所有租户的标准水位、保留其他来源。
- **不声称整个 reloadAll 原子化**：随后原有字典、账单批次及补充镜像仍各有边界；标准水位只证明上述快照事务成功，不能证明整次账单/补充镜像成功。原始快照仍由现有全局镜像结构承载，并非新增租户分表。

### I.2 已核实：单元格聚合、小计和页脚是三个不同阶段

- 同 H.1 命名窗体与统计过程，偏移仍为十进制 EXE 文件偏移；只读静态字节。团队完整复核 5,705 条指令/20,816 字节，Lead 另按原 EXE 导入表核对 12 个格式化/IsNull/IIf/Val 调用、4 个 BSTR、6 个编码引用及 6 个循环/浮点指令，见[团队结论](<.tmp/legacy-statistics-round15-rendering/findings.md>)、[Lead 脚本](<.tmp/legacy-statistics-round15-rendering/lead_verify.py>)与[独立验证结果](<.tmp/legacy-statistics-round15-rendering/lead-verification.json>)。没有执行 EXE/DLL、连接 MIS/生产或安装依赖。
- **每个动态费项单元格**：SQL 先按费项×业主 `SUM(JE)`；字段循环从 9 到 `Fields.Count-1`（@17835268 / @17835291 / @17835295）。显示调用链为 `Format(IIf(IsNull(field),"",field),"#0.00")`（@17835486 / @17835772 / @17835882，写网格 @17836032）。NULL 被送入空 BSTR 分支，数值零不走该分支；不能自行 `COALESCE`。普通零值预期 `0.00`，空串实际显示仍属运行时语义，不伪称现场截图。
- **标准小计**：每条记录先清零 Double 累加器 @17835147–17835152，再独立重新取费项值，执行 `Val(IIf(IsNull(field),"0",Format(field,"#0.00")))`（@17836327 / @17836588 / @17836680 / @17836704），浮点相加 @17836722，最后格式化 `#0.00` @17837047 写末列 @17837207。是**逐费项先格式化、再相加**，不是原始 JE 跨费项求和；也不是直接读取刚写的费项网格。例如两个费项单元格分别 1.004、2.004，显示 1.00、2.00，小计 3.00，而不是原始 3.008 再得到 3.01。
- **标准合计页脚**：`Rows>1` 才追加页脚（@17838629 / @17838656–17838664），仅表头的空结果不追加。面积列 5，以及动态列 9..`Cols-1`（**包含小计列**），对明细行 1..`Rows-2` 读取网格字符串，再 `Val`/Double 相加；费项读取 @17841150、Val @17841174、加法 @17841192，最后 `##,##0.00` @17841406 写页脚 @17841566。页脚不是数据库总计，不应改成跨行原始 JE 的一次 SUM/舍入。
- **固定字段与仍未证明的格式**：地址/姓名/电话/面积/性质/进户/开始收费日期均经 NULL→空串后隐式字符串转换，没有明细面积两位小数或显式 ISO 日期格式。不能把另一打印过程的日期标题格式当明细日期证据。Format 最终进入 Automation VarFormat，未证明半分临界值、负零或实际 ADO 子类型/区域设置下的细节；不能宣称 VB Round 银行家舍入、SQL ROUND 或 JS Math.round 与旧程序完全等价。既有民用日期镜像只代表规范化日期，尚不能保证旧版隐式 BSTR 的时间/区域外观。

### I.3 验证与发布边界

- [新增标准回归](<apps/api/src/modules/fees/charge-standard-mirror.test.ts>)及[既有镜像回归](<apps/api/src/modules/fees/mis-mirror.test.ts>)、[补充镜像回归](<apps/api/src/modules/statistics/mirror-extra.test.ts>)共 **19/19** 通过：幂等迁移/回退、水位区分、超安全整数 ID、money 两端界、0.0049+0.0049 的同单元格精度、NULL/负数/历史/租赁保留、重复/空快照、源失败/缺结果集/损坏传输/重复主键真实事务回滚；另确认定时同步不读 WYDJ、不初始化标准水位。API `tsc --noEmit` 通过，独立只读代码审查 PASS；均为 PGlite 合成数据与静态 SQL/字节证据，不冒充真实 SQL Server 查询或现场验收。
- API/前端报表均未新增，#24 仍待接入。后续仍需原始费项名称/停用元数据、管理处名称、完整楼室地址、显示临界语义与日期外观等证据/镜像准备，不能靠账单地址替代无账单房屋；JE 上游业务单位、独立菜单 ID 调度、模板及现场数据核验仍未完成。
- 未部署、未执行生产迁移/重灌、未增加源读取频率。未来获得当次生产授权后，应先应用两条迁移，再明确执行手工重灌并验证快照和水位；不能用本地通过代替上线结果。

## 附录 J：主数据 ID 精度与完整地址源证据（Round16）

### J.1 修复手工重灌的五个 numeric18 主数据 ID

- [源结构](<outputs/mis-db-sync-20261106/schema-columns.csv#L13007>)确认楼表 L_ID、[室表 S_ID/L_ID](<outputs/mis-db-sync-20261106/schema-columns.csv#L14388-L14390>)、[业主表 ZH_ID/S_ID](<outputs/mis-db-sync-20261106/schema-columns.csv#L15746-L15747>)均为 **NOT NULL numeric(18,0)**。此前只对 WYDJ 转字符串，不能据此声称楼室业主关联也已精确保留。
- [手工重灌](<apps/api/src/modules/fees/mis-mirror.service.ts#L490-L496>)对这五个源字段统一 `CONVERT(varchar(20),…)`；[维度校验](<apps/api/src/modules/fees/dimension-mirror.util.ts>)在任何替换事务前要求真实数组结果集及每个 ID 为 1..18 位有符号十进制字符串。即使安全范围内的 JS Number 也拒绝，防止源端转换被漏掉；缺字段、NULL、数值、指数/小数/空格、19 位 ID 均 503，错误不携带原始源值。源允许的零、负 ID 不擅自过滤，孤立关联不增设外键。
- 三个维度缺结果集不再被 `?? []` 当作成功空快照，避免静默清空；真实 `[]` 仍允许提交。楼/室/业主/标准与标准水位沿用同一既有事务，重复主键等写入失败整体回滚。未新增迁移、接口、源查询次数或定时任务，也没有改变日期、房号默认值、既有统计消费字段与 API 形状。
- [新增精度回归](<apps/api/src/modules/fees/dimension-mirror.test.ts>)先在旧查询复现相邻 `9007199254740992`/`9007199254740993` 被 Number 合并导致楼主键碰撞；修复后真实 PGlite 跨标准→业主→室→楼关联精确保留不同的相邻大 ID 和 18 位上界业主 ID。源传输部分使用**明确的本地驱动模型**（缺 CAST 时返回 Number），不是实际 SQL Server 执行证据。另覆盖三个源结果结构/五个 ID 的 74 个损坏案例在事务前拒绝、非空原账单与镜像/水位保留、重复业主主键事务回滚、零/负关联和真实空快照。
- **精度修复边界**：仅本轮手工维度读取与已有 WYDJ 快照。账单增量/全量 SQL、分页游标的 Number 转换及报表 API 中的数值 ID 仍未在本轮重构，不能宣称全部业务链路都支持超安全整数 ID；完整 reloadAll 仍不是单一事务（见 I.1）。

### J.2 已核实源字段与地址 NULL 差异，尚未新增原始元数据镜像

- [团队证据](<.tmp/legacy-statistics-round16-source-research/findings.md>)及[定点字节复核](<.tmp/legacy-statistics-round16-source-research/native-fixed-offset-verification.txt>)核对命名窗体指针/JMP 和 26 个 BSTR 引用；[Lead 独立脚本](<.tmp/legacy-statistics-round16-source-research/lead_verify.py>)、[结果](<.tmp/legacy-statistics-round16-source-research/lead-verification.json>)另验证原 EXE SHA256、11 个直接引用/指令操作码、8 个地址分段和五个 ID 源类型。偏移均为十进制文件偏移；只读静态 EXE 与表结构字段，没有执行 EXE、读取实际住户行、安装依赖或连接 MIS/生产。
- 原 #24 地址先对楼表 `地址1,字1,地址2,字2,地址3,字3,地址4,字4` 各自 CASE NULL→空串（引用 @17827565–17827684），随后直接 **`+ 室表.室 + CASE 室表.字 …`**（BSTR @1336616，引用 @17827810）。室号没有 NULL→空串；不能替换为现有账单的全分段 ISNULL 拼接。历史 SQL 会话 `CONCAT_NULL_YIELDS_NULL` 未证明，因此保留原始 NULL/空串差异，不声称 NULL 室号最终地址外观已经确定。
- 原 JOIN 是 `设置管理处.GYD_DH=楼表.管理处`（引用 @17827913），不是 GYD_ID 或室表.GYD；业主通过室 S_ID 且 `说明='新进户'` 作为 LEFT JOIN 条件（@17827935）。费用目录用原始 `XM`，不能把 `COALESCE(显示名称,XM)` 当作相同；类别/费项选择只取终止日期 NULL，管理处选择另有商用物业 0/2 和可选部门条件。准确选中项/权限分支仍待模板阶段核实。
- [费项结构](<outputs/mis-db-sync-20261106/schema-columns.csv#L2396-L2410>)中 DH/XM/收费类别/显示名称分别为 nvarchar(50)，终止日期为可空 smalldatetime；[管理处](<outputs/mis-db-sync-20261106/schema-columns.csv#L14187-L14212>)代码 nvarchar(50)、名称 nvarchar(400)。楼八段各可空 nvarchar(50)，室号可空 nvarchar(250)、字可空 nvarchar(50)，完整声明地址长度可达 700。现有镜像的名称/代码/房号/账单地址宽度和 NULL/default 语义不能完整承载这些原始字段。
- 后续需在不改变既有 fee_name、cron 和正常统计消费语义前提下补充原始元数据/地址快照与独立就绪标记，不能把原始字段放进会被 cron 覆盖的回退名称/类别列；不得从字段 CSV 推断代码唯一性、外键或排序规则。完整地址排序/分组、面积 float 精度、日期/金额运行时显示与业务单位等未解决事项仍适用附录 I；本轮没有因此开放 #24。

### J.3 验证与上线边界

- 四套镜像回归共 **22/22**、API `tsc --noEmit` 通过；新增 3 个测试覆盖本轮修复，既有 19 个回归继续覆盖原标准金额、迁移、日期失败、账单/补充镜像和 cron 排除行为。独立只读代码审查 PASS，保留上述 bill/分页精度边界；并将四套加入[常规 test:mis-mirror 脚本](<apps/api/package.json#L48>)，避免新增保护只靠临时手工命令。结果为本地合成数据和离线源证据，不代替真实源重灌、网页报表或生产验收。
- 仅 API 源码/测试与本文档变更；Web/助手未变，报表 #24 仍灰字待接入，整个统计汇总目标仍未完成。未连接生产、未部署、未执行实际迁移或手工重灌。

## 附录 K：账单源 ID 与同步游标精度（Round17）

### K.1 修复入口与失败保护

- [账单源结构](<outputs/mis-db-sync-20261106/schema-columns.csv#L3043-L3045>)的 ZJ_ID/ZH_ID 为 numeric(18,0)，楼/室/业主主键类型见 J.1。[增量/补漏 billSelect 与手工重灌](<apps/api/src/modules/fees/mis-mirror.service.ts>)均将实际投影的 `w.ZJ_ID/l.L_ID/s.S_ID/z.ZH_ID` 四列在 SQL Server 源端 `CONVERT(varchar(20),…)`，不让驱动先将 ID 变为 JS Number。
- [账单校验](<apps/api/src/modules/fees/bill-mirror.util.ts>)要求真实数组结果集及四个必填 ID 字符串匹配 `^-?\d{1,18}$`，不 trim、不补缺值；源端即使安全范围内的 Number 也拒绝。主键分页在返回任何行/执行任何 upsert 前，用 BigInt 验证**整批**严格大于请求游标且逐行递增；相等、倒序、重复、后行损坏均 503。真实空数组可正常结束分页，缺结果集不能冒充空批。
- 增量与重灌游标不再使用 `Number(last_id/zjId)`，源参数保持字符串；重灌收尾 `MAX(zj_id)::text` 避免聚合读回时被 PG 驱动数值化。旧安全整数数值水位仅在 `Number.isSafeInteger` 时转字符串兼容；unsafe Number、非整数或损坏文本拒绝，不能猜测恢复已经舍入的值。
- 补漏仍保持原来的 updatedate 排序、十五分钟频率及超时降级批量。它不是 ZJ_ID 主键分页，因而只验证四个 ID 与结果结构，不强加跨时间组 ID 全局递增；合法的“较晚时间但较小 ID”仍可更新。upsert 前另做同样的结构/ID 校验，不改变金额/日期/票据字段处理、接口权限、cron 或报表 SQL 口径。

### K.2 合成回归与未完成边界

- [新增 11 项](<apps/api/src/modules/fees/bill-mirror.test.ts>)覆盖源结构/四 ID、游标 safe/unsafe Number、四个源 CAST、500 行满批加尾批的两次精确字符串游标、相邻 `2^53`/`2^53+1` 与 18 位维度 ID 的 PG 账单→业主→室→楼关联、账单成功水位、坏批整批拒绝、补漏非全局递增与失败保护；加入[常规 test:mis-mirror](<apps/api/package.json#L48>)。旧实现已明确复现：含被舍入 numeric18 Number 的源批未被拒绝，`assert.rejects` 报 `Missing expected rejection`；修复后的预期行为为 503。
- 这是本地驱动桩与真实 PGlite 的合成证据，不是实际 SQL Server CONVERT/传输/执行计划或现场数据验收。手工重灌仍从原有正 ID 起点 `'0'` 扫描，未扩大到负/零 ID 的首次载入；补漏原有覆盖范围也未重设计。
- **不是全链路 ID 重构**：住户明细 houseKey 解析及其他 API/read 路径仍可能存在 Number，不能据本轮声称所有金额下钻均支持超安全整数 ID。
- **不是整次同步原子或历史修复**：reloadAll 的维度/标准事务先提交，账单逐批 upsert；增量也逐批提交。无效批在写入前拒绝且不推进最终账单成功水位，但更早的合法批次/维度可能已提交。既有 reloadAll 不清空账单表，因此本轮不会自动删除源已删账单或清理历史舍入造成的旧行；不能把上游结构校验文案理解为全库回滚承诺。
- 五套镜像回归通过常规脚本共 **33/33**（新增 11，既有 22），API `tsc --noEmit` 通过；团队另独立运行 33/33、单套 11/11 与类型检查，只读审查 **PASS**。审查及 Lead 复核[源参数绑定](<apps/api/src/modules/fees/mis-fees.service.ts#L120-L129>)：字符串传为 NVarChar(4000)，保留 `w.ZJ_ID > @lastId`，按 SQL Server 类型优先级由参数转 numeric 比较，不是词典序或对列转 varchar；没有实际执行计划证据，不能承诺索引 seek 或耗时。这些仅证明上述本地代码、静态语义与合成数据边界。
- 已经舍入但仍符合格式的**字符串旧水位**无法自动识别；重灌收尾仍取镜像 MAX，而非本次源最后一行，旧高 ID 幻影行可能抬高水位。重灌在账单循环前仍写 initialized_at/清 last_error，后续坏批不推进 last_success 并不代表初始化元数据完全不变。坏批会阻断后续主分页而非跳过，应结合 last_error 监控和授权后的独立对账处理；不在本轮自动重置水位或清理数据。
- 没有新增迁移、报表入口或 Web/助手变更；#24 仍灰字。未连接 MIS/生产、未部署或执行实际迁移/重灌；统计汇总整体目标仍未完成。

## 附录 L：年度房屋→逐笔账单源 ID 无损传递（Round18）

### L.1 契约与兼容边界

- Round17 的源镜像修复不等于报表读取安全。旧[年度服务](<apps/api/src/modules/statistics/statistics.service.ts>)将 detail 的 sId 和 bills 的 zjId 再次 `Number()`，旧[年度账单 DTO](<apps/api/src/modules/statistics/dto.ts>)也先数值化 query。合成旧源码 RED 已复现：相邻 `999999999999999998` / `999999999999999999` 都返回 `1000000000000000000`，HTTP 字符串 `9007199254740993` 变成 Number `9007199254740992`；指数 `1e3` 还会被当成合法 ID。
- 年度 `annual/detail` 与 `annual/detail/bills` 的非空 **sId/zjId 统一返回字符串，包括小 ID**；实收按户×应收月聚合的 zjId 仍为 null，原 sId:null 也保留 null。Bills 的 filters.sId 同样返回规范字符串。[SQL](<apps/api/src/modules/statistics/statistics.service.ts>)仅在 SELECT 把 ID `::text`，JOIN/GROUP BY/ORDER BY/参数与列的数值比较不改为字符串排序，不改变金额、日期、退款净额、筛选、权限或查询次数口径。
- [年度 ID 守卫](<apps/api/src/modules/statistics/annual-source-id.util.ts>)及[DTO](<apps/api/src/modules/statistics/dto.ts>)要求逐笔请求 sId 为 1–18 位、首位非零的十进制正整数字符串，不 trim、不接受指数/小数/加号/前导零/数组/空白/19 位或已失精度 Number。HTTP query 本来就是字符串；进程内旧 safe-integer 数字调用可转字符串兼容。0/负数仍不开放（维持原 `Min(1)` 的正数范围）；非法请求 400，在数据库前拒绝。源输出守卫接受 numeric(18,0) 范围的有符号整数文本，异常/unsafe Number 503，不能用 `String(unsafeNumber)` 假装恢复精度。
- [前端年度类型](<apps/neighbor-web/src/lib/statistics.ts>)与[房屋下钻](<apps/neighbor-web/src/components/statistics/HouseDetailSheet.tsx>)同步收紧为字符串，空/NULL ID 不发逐笔请求，不对 ID 做算术或 Number 转换。既有展示、金额、筛选和布局不变。这是年度两张报表的 API ID 类型调整，不是所有 PMS API 的 ID 迁移；发布时 API 与 neighbor-web 应同批核验，不保证外部自写客户端仍能把响应 ID 当 number 运算。

### L.2 回归与未完成项

- [新增 13 项](<apps/api/src/modules/statistics/annual-id-precision.test.ts>)从旧源码 **8/8 RED** 转为 **13/13 GREEN**，覆盖两种类型真实 StatisticsService+PGlite 单元格→房屋→逐笔守恒、相邻 18 位户/账单独立、筛选与越权 403、PG 文本投影、HTTP DTO 精确文本、坏格式/unsafe Number、旧 safe-number 调用、数据库前拒绝、源 NULL 兼容。加入[常规 test:statistics](<apps/api/package.json#L27>)；旧[年度测试](<apps/api/src/modules/statistics/statistics.test.ts>)仅调整 ID 期望，不删金额/退款/日期/权限/未就绪等断言。完整年度回归 **50/50**、API `tsc --noEmit` 通过。
- 上述为本地 PGlite 合成证据；前端浏览器、独立审查及推送后构建结果另补，不将其预先标为通过。未访问 MIS/生产，未部署、迁移、手工重灌或自动修复历史舍入数据。
- 前端在既有浏览器 harness 上走真实组建交互：04/2020 大 ID 单元格→房屋明细→点击行→逐笔请求 query 保持 `9007199254740993`，两行 `data-bill-id` 分别为 `…993/…994` 且均可见，390 窄屏复用同场景不横向溢出；该定向用例 1/1 通过。整套 `test:statistics` 曾 56/57，唯一失败为筛选浮层用例的 `fetch failed: bad port` 端口竞态，单独重跑通过。前端 `typecheck` 通过。
- 独立只读审查 **PASS**（API service/DTO/守卫/SQL、前端类型与通路、其他报表 DTO 未改），仅提出非阻断项：实收聚合行 zjId 应为 `string|null`、夹具通用 received 分支仍为数字、bills 绑定参数未直接断言——前两项已在推送前修正，第三项已补进回归。
- 本轮提交 `bb7dd926` 已推送到 `main`；推送前 pre-push 的 API 类型检查通过。随后在**干净 detached worktree**（HEAD=origin/main=`bb7dd926`）里分别构建 API（`nest build`）与 neighbor-web（`tsc --noEmit && vite build`），退出码均 0，构建未改动受版本控制源码，产物哈希记录在 `.tmp/legacy-statistics-round18-annual-id/build-evidence/verification.json`（`statistics.service.js` SHA256 `29209EC5…FCEA0`、`dto.js` `2DD25600…C089C32F`、`annual-source-id.util.js` `3ADD607D…C42A03`，Web 98 个文件）。本次构建需把 `TEMP/TMP` 指到任务自建目录，宿主机默认 `%TEMP%` 下 esbuild 压缩临时文件删除被拒（`Access is denied`），属本机构建环境问题，不影响源码与产物内容。
- 上述均为本地合成/隔离构建证据：当前没有生产授权，未连接 MIS/生产、未部署、未执行迁移或手工重灌。
- 费用模块 houseKey 解析、其他统计菜单的 Number ID、#24 原始元数据/地址/日期/金额旧运行时语义及附录 I/K 其他边界仍未完成。整体统计汇总目标未完成，不能以本轮年度下钻精度修复声称全部菜单已生产可用。

## 附录 M：一期 2007 年欠费「54321.80 对 0」对账（Round19）

### M.1 结论：不是房号不一致，是 06 空房默认不勾

- 用 [MIS 离线快照](<outputs/mis-db-sync-20261106/README.md>)（2026-11-06 15:38 导出，WYZJ 650,824 行）按镜像同一口径复算：**管理处 01 × 2007 年未收 = 54321.80 元，39 行**，与旧系统窗口截图完全一致。
- 这 39 行**全部是房屋性质 `06`（空房）**、收费项目 `01`、涉及 5 个室号（S_ID 1663/1661/1520/1521/1517）。[欠费年度汇总默认不勾 06](<apps/neighbor-web/src/components/statistics/StatisticsFilters.tsx#L260>)，所以 PMS 该格为 0；把「06 空房」勾上后同一格即为 54321.80。为避免再被误读为漏数，结果头在欠费未勾 06 时显示「已排除 06 空房」提示（[Statistics.tsx](<apps/neighbor-web/src/pages/Statistics.tsx>)），实收报表含 06 时不显示，浏览器用例已断言这两种状态。
- 房号并非差异来源：快照 2,346 个室**全部有室号**，2007 年这 5 户的室号/业主与截图一致（187/157-159/199-201/203/191）；镜像的 `room_no` 与 `address` 取自 `室表.室` + `楼表.地址1…字4`，本次窗口显示的“永德路187号187室”即该组合结果。没有发现漏同步或串号证据。- 06 空房并非只影响 2007：01 管理处 2008–2015 每年有约 21226.80 元、2016–2018 每年 2736.00 元是 06 部分；02/03/04 管理处在快照内没有 06 未收。与旧系统全选性质对账时，这些差额都来自这一项筛选。

### M.2 其它对账缺口

- 快照中有 **149 行未收（合计 20155.00 元）的 WYZJ 记录 `ZH_ID` 为空**，镜像 SQL 用 `INNER JOIN 业主表` 关联，这些行不会进入镜像，也不属于 2007。按年度：2009 750.00、2010 500.00、2015 785.00、2016 2510.00、2018 100.00、2019 320.00、2020 2940.00、2021 2700.00、2022 1200.00、2023 100.00、2025 3600.00、2026 4650.00。它们看起来是非日常/无业主账户的应收，若要完整复刻需要给镜像补一条不依赖业主表的来源（涉及改同步与生产重灌，需单独授权）。

### M.3 复现方式与边界

- 新增只读对账脚本 [parity-audit.mjs](<tools/statistics-parity-audit/parity-audit.mjs>)：`node tools/statistics-parity-audit/parity-audit.mjs --office 01 --year 2007 --detail` 输出管理处×年度的「未收(全部)/未收(不含06)/其中06」以及明细行，便于以后每份新快照复用同一口径复核。
- 依据是本地 CSV 逻辑快照，不是执行生产 PMS SQL，也没有连接 MIS/生产；快照 CSV 未导出楼表地址分段列，脚本明细只显示室号。默认是否包含 06 属于产品口径选择：当前默认与 2026 年基线截图一致（排除 06），本轮未擅自改默认值。
