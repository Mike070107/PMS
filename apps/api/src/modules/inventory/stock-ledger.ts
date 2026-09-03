import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StockMovementType } from '../../common/enums';
import { Material, Stock, StockLot, StockMovement } from '../../entities';

/**
 * 库存台账（批次 + 先进先出）的唯一实现。
 *
 * 为什么单独抽出来：动库存的入口有五个（采购入库、一般入库、调拨发/收、工单领料、盘点调整），
 * 之前 InventoryService 和 RepairsService 各复制了一份 consumeStockLots / applyStockDelta，
 * 任何口径调整都要改两处、漏一处就是两套账。**新增任何动库存的入口一律走这里**，
 * 不要再直接读写 Stock / StockLot。
 *
 * 口径（详见 docs/inventory-costing.md）：
 * - 同一 SKU 不同入库单价 = 同一 SKU 多条批次（stock_lots）。绝不因为价格不同建新 SKU，
 *   那会把安全库存预警、搜索、采购历史、消耗统计全部拆碎。
 * - 出库按批次 received_at 先进先出扣减，成本取被扣批次的单价，**快照**写进
 *   stock_movements / work_order_materials / work_order_material_allocations。
 *   之后再入多贵的货都不回头改历史，报表一律读快照，不要在查询时拿当前价 × 数量现算。
 * - materials.default_cost_cents 是「参考成本」：全公司剩余批次的移动加权均价，
 *   入库 / 盘盈后自动刷新。只用于展示、盘盈默认单价、没批次的老库存兜底，不参与出库成本。
 * - 批次总量 < 库存数量（上批次功能之前的老库存）时，出库前自动补一条 LEGACY 批次，
 *   received_at=1970 保证最先被扣，成本取参考成本。
 */

export interface LotAllocation {
  stockLotId: number;
  qty: number;
  unitCostCents: number;
  amountCents: number;
}

interface StockKey {
  tenantId: number;
  warehouseId: number;
  materialId: number;
}

/** 数量都是两位小数的 numeric，减法后 toFixed(2) 避免 0.1+0.2 这类浮点尾巴 */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * 安全库存是补货触发线，不是“跌穿后才提醒”：到达阈值就应该预警。
 * 0 表示按需采购、不设常备线，不能把所有 0 库存 SKU 都算成预警。
 */
export function isSafetyStockWarning(qty: number, safetyQty: number): boolean {
  return safetyQty > 0 && qty <= safetyQty;
}

/** 批次加权均价；没有批次时退回 SKU 参考成本。**只做展示**，金额一律用 resolveStockValue */
export function resolveUnitCost(lotQty: number, lotValueCents: number, defaultCostCents: number): number {
  return lotQty > 0 ? Math.round(lotValueCents / lotQty) : defaultCostCents;
}

/**
 * 某行库存的金额（分）：批次剩余值直接加总，批次盖不住的部分按参考成本兜底。
 *
 * 不要写成 round(数量 × 加权均价)——均价四舍五入到分之后再乘回数量会差出几分钱：
 * 马桶 1 只 ¥278 + 5 只 ¥280 = ¥1,678.00，均价 round(167800/6)=27967，
 * 6 × 27967 = ¥1,678.02，和客户手上的清单对不上（2026-08-31 上海新家期初导入实测）。
 * 期初补录、财务对账都要求分毫不差，所以金额从批次原值出，均价只是给人看的。
 */
export function resolveStockValue(
  qty: number,
  lotQty: number,
  lotValueCents: number,
  defaultCostCents: number,
): number {
  const uncovered = Math.max(0, round2(qty - lotQty));
  return Math.round(lotValueCents + uncovered * defaultCostCents);
}

export function averageUnitCost(allocations: LotAllocation[], qty: number): number {
  if (!qty) return 0;
  const total = allocations.reduce((sum, item) => sum + item.amountCents, 0);
  return Math.round(total / qty);
}

/**
 * 改数量并落一条流水；库存行不存在就建。不动批次——批次由调用方按语义处理。
 *
 * 返回值把**流水行**也带出来：冲回时要把新流水的 reversalOfMovementId 指向原出库流水，
 * 靠它上面的唯一索引保证「一条扣料最多只被冲销一次」（2026-09-03 工单撤回退料）。
 */
export async function applyStockDelta(
  manager: EntityManager,
  input: StockKey & {
    deltaQty: number;
    type: StockMovementType;
    unitCostCents: number;
    refType: string;
    refId: number | null;
    operatorId: number | null;
    note?: string | null;
    /** 入库时的存放库位。只在入库（deltaQty > 0）时写，出库不动原来的库位 */
    locationId?: number | null;
    /** 本条是冲回时，指向被冲销的那条出库流水 id */
    reversalOfMovementId?: number | null;
  },
): Promise<{ stock: Stock; movement: StockMovement }> {
  let stock = await manager.findOne(Stock, {
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (!stock) {
    stock = manager.create(Stock, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
      qty: 0,
      safetyQty: 0,
      createdBy: input.operatorId,
      updatedBy: input.operatorId,
    });
  }
  const nextQty = round2(Number(stock.qty) + input.deltaQty);
  if (nextQty < 0) throw new BadRequestException('stock is insufficient');
  stock.qty = nextQty;
  // 库位跟着入库走：出库不改（东西还在原来那格），入库没指定也不清掉已有的
  if (input.deltaQty > 0 && input.locationId) stock.locationId = input.locationId;
  stock.updatedBy = input.operatorId;
  await manager.save(Stock, stock);

  const movement = await manager.save(
    StockMovement,
    manager.create(StockMovement, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
      type: input.type,
      qty: input.deltaQty,
      unitCostCents: input.unitCostCents,
      refType: input.refType,
      refId: input.refId,
      note: input.note ?? null,
      reversalOfMovementId: input.reversalOfMovementId ?? null,
      createdBy: input.operatorId,
      updatedBy: input.operatorId,
    }),
  );
  return { stock, movement };
}

export async function createStockLot(
  manager: EntityManager,
  input: StockKey & {
    qty: number;
    unitCostCents: number;
    supplierId: number | null;
    purchaseOrderId: number | null;
    goodsReceiptId: number | null;
    sourceType: string;
    sourceId: number | null;
    lotNo: string;
    operatorId: number | null;
    receivedAt?: Date;
  },
): Promise<StockLot> {
  return manager.save(
    StockLot,
    manager.create(StockLot, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
      lotNo: input.lotNo,
      initialQty: input.qty,
      remainingQty: input.qty,
      unitCostCents: input.unitCostCents,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId,
      goodsReceiptId: input.goodsReceiptId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      receivedAt: input.receivedAt ?? new Date(),
      createdBy: input.operatorId,
      updatedBy: input.operatorId,
    }),
  );
}

/**
 * 老库存兜底：批次功能上线前就有的数量没有批次记录，出库前补一条 LEGACY 批次，
 * 数量 = 库存数 − 现有批次剩余，成本取参考成本，received_at=1970 保证最先被扣。
 */
async function ensureLegacyLotIfNeeded(
  manager: EntityManager,
  input: StockKey & { qty: number; operatorId: number | null },
) {
  const lots = await manager.find(StockLot, {
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
    },
  });
  const lotQty = lots.reduce((sum, lot) => sum + Number(lot.remainingQty), 0);
  if (lotQty >= input.qty) return;

  const stock = await manager.findOne(Stock, {
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      materialId: input.materialId,
    },
    lock: { mode: 'pessimistic_write' },
  });
  const missingLotQty = round2(Number(stock?.qty ?? 0) - lotQty);
  if (missingLotQty <= 0) return;

  const material = await manager.findOne(Material, {
    where: { id: input.materialId, tenantId: input.tenantId },
  });
  await createStockLot(manager, {
    tenantId: input.tenantId,
    warehouseId: input.warehouseId,
    materialId: input.materialId,
    qty: missingLotQty,
    unitCostCents: material?.defaultCostCents ?? 0,
    supplierId: null,
    purchaseOrderId: null,
    goodsReceiptId: null,
    sourceType: 'legacy_stock',
    sourceId: stock?.id ?? null,
    lotNo: `LEGACY-${input.warehouseId}-${input.materialId}`,
    operatorId: input.operatorId,
    receivedAt: new Date(0),
  });
}

/** 先进先出扣批次，返回每批扣了多少、什么单价——调用方把它写进分摊表 / 单据快照 */
export async function consumeStockLots(
  manager: EntityManager,
  input: StockKey & { qty: number; operatorId: number | null },
): Promise<LotAllocation[]> {
  await ensureLegacyLotIfNeeded(manager, input);
  const lots = await manager
    .createQueryBuilder(StockLot, 'lot')
    .where('lot.tenant_id = :tenantId', { tenantId: input.tenantId })
    .andWhere('lot.warehouse_id = :warehouseId', { warehouseId: input.warehouseId })
    .andWhere('lot.material_id = :materialId', { materialId: input.materialId })
    .andWhere('lot.remaining_qty > 0')
    .orderBy('lot.received_at', 'ASC')
    .addOrderBy('lot.id', 'ASC')
    .setLock('pessimistic_write')
    .getMany();

  let remaining = input.qty;
  const allocations: LotAllocation[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const available = Number(lot.remainingQty);
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    lot.remainingQty = round2(available - take);
    lot.updatedBy = input.operatorId;
    await manager.save(StockLot, lot);
    allocations.push({
      stockLotId: lot.id,
      qty: take,
      unitCostCents: lot.unitCostCents,
      amountCents: Math.round(take * lot.unitCostCents),
    });
    remaining = round2(remaining - take);
  }
  if (remaining > 0) throw new BadRequestException('stock lot is insufficient');
  return allocations;
}

/**
 * 把一次扣减原样退回批次（冲回）。用于「同一单重新提交用料」这类要先撤销上次扣减的场景。
 * 只还批次数量，库存数量由调用方用 applyStockDelta 加回并留流水，保证冲回也有痕迹。
 */
export async function restoreStockLots(
  manager: EntityManager,
  allocations: Array<Pick<LotAllocation, 'stockLotId' | 'qty'>>,
  operatorId: number | null,
): Promise<void> {
  for (const allocation of allocations) {
    if (!allocation.stockLotId || Number(allocation.qty) <= 0) continue;
    const lot = await manager.findOne(StockLot, {
      where: { id: allocation.stockLotId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lot) continue;
    lot.remainingQty = round2(Number(lot.remainingQty) + Number(allocation.qty));
    lot.updatedBy = operatorId;
    await manager.save(StockLot, lot);
  }
}

/**
 * 刷新 SKU 参考成本 = 全公司剩余批次的加权均价。
 * 入库 / 盘盈 / 冲回之后调；没有任何剩余批次时保留原值（新 SKU 手填的价先留着）。
 */
export async function refreshMaterialReferenceCost(
  manager: EntityManager,
  tenantId: number,
  materialId: number,
  operatorId: number | null,
): Promise<number | null> {
  const row = await manager
    .createQueryBuilder(StockLot, 'lot')
    .select('COALESCE(SUM(lot.remaining_qty), 0)', 'qty')
    .addSelect('COALESCE(SUM(lot.remaining_qty * lot.unit_cost_cents), 0)', 'value')
    .where('lot.tenant_id = :tenantId', { tenantId })
    .andWhere('lot.material_id = :materialId', { materialId })
    .andWhere('lot.remaining_qty > 0')
    .getRawOne<{ qty: string; value: string }>();
  const qty = Number(row?.qty ?? 0);
  if (qty <= 0) return null;
  const avg = Math.round(Number(row?.value ?? 0) / qty);
  await manager.update(Material, { id: materialId, tenantId }, { defaultCostCents: avg, updatedBy: operatorId });
  return avg;
}

export interface LotSummary {
  lotQty: number;
  lotValueCents: number;
}

/**
 * 各（仓 × 材料）剩余批次的数量与金额，key 为 `${warehouseId}:${materialId}`。
 * 库存清单估值用；报表页的 stock 查询是同一段聚合 SQL 的 JOIN 版本，改口径两边一起改。
 */
export async function summarizeLots(
  manager: EntityManager,
  tenantId: number,
  filter: { warehouseId?: number; materialId?: number } = {},
): Promise<Map<string, LotSummary>> {
  const qb = manager
    .createQueryBuilder(StockLot, 'lot')
    .select('lot.warehouse_id', 'warehouseId')
    .addSelect('lot.material_id', 'materialId')
    .addSelect('SUM(lot.remaining_qty)', 'lotQty')
    .addSelect('SUM(lot.remaining_qty * lot.unit_cost_cents)', 'lotValueCents')
    .where('lot.tenant_id = :tenantId', { tenantId })
    .andWhere('lot.remaining_qty > 0')
    .groupBy('lot.warehouse_id')
    .addGroupBy('lot.material_id');
  if (filter.warehouseId) qb.andWhere('lot.warehouse_id = :warehouseId', { warehouseId: filter.warehouseId });
  if (filter.materialId) qb.andWhere('lot.material_id = :materialId', { materialId: filter.materialId });
  const rows = await qb.getRawMany<{ warehouseId: string; materialId: string; lotQty: string; lotValueCents: string }>();
  const map = new Map<string, LotSummary>();
  for (const row of rows) {
    map.set(`${row.warehouseId}:${row.materialId}`, {
      lotQty: Number(row.lotQty),
      lotValueCents: Number(row.lotValueCents),
    });
  }
  return map;
}
