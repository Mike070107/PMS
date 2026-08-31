# 库存成本口径：同一 SKU 不同价格怎么入库、怎么出库、怎么算报表

> 2026-08-28 调研 + 落地。代码入口：`apps/api/src/modules/inventory/stock-ledger.ts`（唯一实现），
> 报表：`modules/reports/reports.service.ts`，后台：`pages/InventoryPage.tsx`。

## 结论

| 问题 | 答案 |
|---|---|
| 同一个 SKU 这批 13.5、下批 15.0，怎么入库 | **照常按同一个 SKU 入，填这一批的实际单价**。系统每一行入库明细自动生成一条批次（`stock_lots`），各自带单价、供应商、采购单、入库单号 |
| 要不要建新 SKU | **绝不**。价格不同就拆编码，安全库存预警、搜索、采购历史、消耗统计全碎掉，维修工选料也懵。只有规格真的不同才是新 SKU |
| 加权平均还是先进先出 | **出库按先进先出（FIFO）扣批次，成本取被扣批次的单价**；同时 SKU 上维护一个「参考成本」= 剩余批次的移动加权均价，只用于估价和展示。两者并存，各管各的 |
| 会不会影响历史报表 | **不会**。出库那一刻的单价/金额已经**快照**进 `stock_movements`、`work_order_materials`、`work_order_material_allocations`，之后再入多贵的货都不回头改。报表一律读快照，不在查询时拿当前价 × 数量现算 |

## 为什么选 FIFO 批次而不是纯加权平均

- 《企业会计准则第 1 号——存货》允许先进先出、加权平均、个别计价，不允许后进先出。两种都合规。
- 物业维修材料的诉求是**追溯**：「这张工单用的是哪个供应商哪批货」「为什么这次领料比上次贵」。
  加权平均把价格抹平，答不了这两个问题；批次能答。
- 加权平均的另一个坑：补录过去的入库单会把当前均价搅乱；批次按 `received_at` 排，补录只影响它自己那一批。
- 代价是实现复杂——但批次表、分摊表和 FIFO 扣减在本次之前就已经做完了，只是有几个口子没堵。

## 数据流

```
采购入库 / 一般入库 ──► 每行明细一条 stock_lots(unit_cost, remaining_qty)
                        ├─► stocks.qty += n，stock_movements(inbound, unit_cost)
                        └─► materials.default_cost_cents = 全公司剩余批次加权均价（参考成本）

工单完工领料 ──► consumeStockLots：按 received_at 先进先出扣批次
                 ├─► work_order_material_allocations：扣了哪几批、各多少、各什么价
                 ├─► work_order_materials.unit_cost(加权) / total_cost(合计)   ← 报表读这里
                 └─► stocks.qty -= n，stock_movements(outbound, 加权价)

调拨 ──► 发货仓 FIFO 扣批次 ──► 接收仓按原批次成本重建批次（成本不失真）

盘点调整 ──► 盘盈：新建批次（填单价，默认参考成本）+ 流水 + 刷新参考成本
          └─► 盘亏：FIFO 扣批次 + 流水（成本取被扣批次加权）

老库存（批次功能之前的数量）──► 第一次出库时自动补一条 LEGACY 批次：
                                数量 = 库存数 − 批次剩余，单价 = 参考成本，received_at=1970 保证最先被扣
```

## 本次改了什么

### 1. 批次逻辑抽成唯一实现 `stock-ledger.ts`

`InventoryService` 和 `RepairsService` 之前各自复制了一份 `consumeStockLots / applyStockDelta / ensureLegacyLot / averageUnitCost`，
任何口径调整要改两处。现在都改成调 `stock-ledger.ts` 的导出函数；**新增任何动库存的入口一律走它**，
不要再直接读写 `Stock / StockLot`。附带单测 `stock-ledger.test.ts`（FIFO 跨批、LEGACY 兜底、冲回、负库存拒绝）。

### 2. 库存估值改按批次

后台「库存与采购」页原来的库存总值 = 数量 × `default_cost_cents`（默认成本从不刷新，等于随便一个数）。
现在 `GET /stocks` 每行附带 `lotQty / lotValueCents / unitCostCents / costSource / amountCents`，
口径和报表页「库存清单」完全一致（共用 `resolveUnitCost`）：有批次按剩余批次加权，没有才退回参考成本并打 `*`。
页面上新增「库存总值」指标卡和「批次均价」「库存金额」两列。

### 3. `default_cost_cents` 语义改成「参考成本」，入库自动刷新

实体注释原来写「采购入库会刷新加权均价」但代码从来没做。现在采购入库、一般入库、盘盈之后
调 `refreshMaterialReferenceCost`，把它刷新为**全公司剩余批次的加权均价**。没有任何剩余批次时保留手填值。
后台/小程序上的「默认成本」文案统一改成「参考成本」，并注明「入库后自动按均价刷新」。

用途只有三个：估价展示、盘盈默认单价、老库存兜底。**出库成本永远取批次单价，不用它。**

### 4. 手工改库存变成真正的盘点调整

原来 `PATCH /stocks/:id` 直接改 `stocks.qty` 不动批次：调多了下次出库补 LEGACY 批次、调少了批次总量 > 实物、
之后出库会扣到不存在的批次。现在：

- 盘盈：新建一条 `stock_adjust` 批次（`ADJ-yyyymmdd-xxxxxxxx`），单价用表单填的 `unitCostCents`，不填取参考成本；流水带成本；刷新参考成本。
- 盘亏：FIFO 扣批次，流水成本取被扣批次加权价。
- 新增 `note` 字段写进流水备注（「盘点调整：月末盘点」）。

后台编辑库存弹窗会根据填的数量自动切换：比现在多 → 出现「盘盈单价」；比现在少 → 提示按先进先出扣哪批。

### 5. 批次 / 流水查询

- `GET /stocks/:id/lots`：某条库存的全部批次（含已用完），先进先出顺序。
- `GET /stock-movements?warehouseId&materialId&limit`：出入库流水，最新在前。
- 后台库存清单每行多了「批次」按钮，抽屉里看批次表 + 最近 100 条流水。

### 6. 完工重复提交时先冲回

`completeWorkOrder` 里「已有用料行」的分支原来只删记录不还库存，将来若加「退回重做」会双扣。
现在先 `restoreStockLots` 把批次剩余加回、`applyStockDelta` 加回数量并留一条 `adjust` 流水，再按新提交的重新扣。
当前状态机不允许二次完工，这条路径暂时走不到，但口径已经对了。

## 没改、需要注意的

- **`stock_lots` 等表在生产上是 `DB_SYNCHRONIZE=true` 建出来的**（`deploy/README.md` 的 env 示例仍是 true，
  安全 TODO 里「改成 false + 首版 migration」还没勾）。`src/migrations/` 里只有 RBAC 之后的几条。
  本次没有新增表或列，不需要迁移；但下次确认服务器 `.env` 时顺手把这条 TODO 处理掉。
- 调拨接收有差异（实收 < 发出）时，差额只是不建批次，没有单独的报损流水。数量小、暂不处理。
- 批次的 `received_at` 是录单时间，不是货物实际到货日；补录旧单会排在后面。要按实际日期得给入库单加「到货日期」字段。
- 期初库存导入（从老系统）应该走「一般入库」或盘盈，带上单价，别直接写 `stocks.qty`。

## 报表怎么读才不会错

| 报表 | 读哪里 | 是否受后续价格影响 |
|---|---|---|
| 工单材料成本 / 维修工成本 KPI | `work_order_materials.total_cost_cents`（快照） | 否 |
| 材料使用明细 | `work_order_materials` + `allocations`（快照） | 否 |
| 库存清单估值 | `stock_lots` 剩余 × 单价（当前时点） | 是——这是它应该的样子，估值就是当前值 |
| 出入库流水 | `stock_movements.unit_cost_cents`（快照） | 否 |

一句话：**凡是「发生过的事」读快照，凡是「现在有多少钱的货」读批次剩余。** 不要在任何报表里出现 `qty × materials.default_cost_cents`。

## 价格不同 ≠ 多批次：先问是不是同一种货（2026-08-31 上海新家踩过）

清单里同名多价的行，动手前先分清两种情况：

| 情况 | 判断 | 处理 |
|---|---|---|
| 同一种货，不同时间买的不同价 | 规格、用途完全一样，只是采购价浮动 | 同一 SKU 多条批次（本文默认口径） |
| 其实是不同规格的货，清单规格栏没写 | 价差大得离谱（断路器 ¥55 vs ¥20）、客户能说出型号差别 | **补全 spec、拆成不同 SKU** |

上海新家的断路器 ¥55/¥20、马桶 ¥278/¥280 就是第二种：纸质清单规格栏空着，导入按
name+spec 判重并成了一个 SKU。并错的后果：库存数把两种货加在一起、领料 FIFO 会扣错货的成本。

- 预防：`inventory-stock-import.mjs` 遇到同名同规格多价**默认拒绝**，要么补 spec、
  要么 `--allow-multi-price` 明确确认；
- 补救：`tools/inventory-split-sku.mjs --lot <批次id> --name X --spec Y`，把整条批次连库存、
  流水搬到新 SKU，参考成本两边重算，各仓总值分毫不变（工具自带守恒校验）。
  只允许搬「原封未动」的批次；被工单领用过的拒绝搬，那时候只能人工核。

## 金额与均价的四舍五入（2026-08-31 上海新家期初导入踩过）

行金额**必须从批次剩余值直接加总**（`resolveStockValue`），不能 `round(数量 × 加权均价)`：
均价四舍五入到分再乘回数量会差出几分钱——马桶 1 只 ¥278 + 5 只 ¥280 = ¥1,678.00，
均价口径算出 ¥1,678.02，客户拿纸质清单一对就不认。均价（`resolveUnitCost`）只做展示，
任何新页面/导出要显示金额，一律引 `resolveStockValue`。
