import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityManager } from 'typeorm';
import { StockMovementType } from '../../common/enums';
import { Material, Stock, StockLot, StockMovement } from '../../entities';
import {
  applyStockDelta,
  averageUnitCost,
  consumeStockLots,
  isSafetyStockWarning,
  resolveStockValue,
  resolveUnitCost,
  restoreStockLots,
} from './stock-ledger';

test('安全库存大于0且当前库存到达或低于阈值时预警', () => {
  assert.equal(isSafetyStockWarning(1, 1), true);
  assert.equal(isSafetyStockWarning(0, 1), true);
  assert.equal(isSafetyStockWarning(2, 1), false);
  assert.equal(isSafetyStockWarning(0, 0), false);
});

/**
 * 内存版 EntityManager：只实现 stock-ledger 用到的那几个方法。
 * 目的是验证「先进先出扣哪几批、成本怎么算、老库存怎么兜底」这些口径，不碰真库。
 */
function fakeManager() {
  const tables = new Map<unknown, Record<string, any>[]>([
    [Stock, []],
    [StockLot, []],
    [StockMovement, []],
    [Material, []],
  ]);
  let nextId = 1;
  const rows = (entity: unknown) => tables.get(entity)!;
  const matches = (row: Record<string, any>, where: Record<string, any> = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const manager = {
    tables,
    create: (_entity: unknown, data: Record<string, any>) => ({ ...data }),
    save: async (entity: unknown, data: Record<string, any>) => {
      const list = rows(entity);
      if (!data.id) data.id = nextId++;
      const index = list.findIndex((row) => row.id === data.id);
      if (index >= 0) list[index] = data;
      else list.push(data);
      return data;
    },
    find: async (entity: unknown, options: { where?: Record<string, any> } = {}) =>
      rows(entity).filter((row) => matches(row, options.where)),
    findOne: async (entity: unknown, options: { where?: Record<string, any> } = {}) =>
      rows(entity).find((row) => matches(row, options.where)) ?? null,
    update: async (entity: unknown, where: Record<string, any>, patch: Record<string, any>) => {
      rows(entity).filter((row) => matches(row, where)).forEach((row) => Object.assign(row, patch));
    },
    createQueryBuilder: (_entity: unknown) => {
      const params: Record<string, any> = {};
      const chain: any = {
        where: (_sql: string, p?: Record<string, any>) => { Object.assign(params, p); return chain; },
        andWhere: (_sql: string, p?: Record<string, any>) => { Object.assign(params, p); return chain; },
        orderBy: () => chain,
        addOrderBy: () => chain,
        setLock: () => chain,
        getMany: async () =>
          rows(StockLot)
            .filter((lot) =>
              lot.tenantId === params.tenantId
              && lot.warehouseId === params.warehouseId
              && lot.materialId === params.materialId
              && Number(lot.remainingQty) > 0)
            .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id - b.id),
      };
      return chain;
    },
  };
  return manager as unknown as EntityManager & { tables: typeof tables };
}

const KEY = { tenantId: 1, warehouseId: 10, materialId: 100 };

async function seedLot(manager: EntityManager, qty: number, unitCostCents: number, receivedAt: Date) {
  return manager.save(StockLot, manager.create(StockLot, {
    ...KEY,
    lotNo: `L-${unitCostCents}`,
    initialQty: qty,
    remainingQty: qty,
    unitCostCents,
    receivedAt,
  }));
}

test('resolveUnitCost：有批次按批次加权，没有退回参考成本', () => {
  assert.equal(resolveUnitCost(10, 1500, 999), 150);
  assert.equal(resolveUnitCost(0, 0, 999), 999);
  assert.equal(resolveUnitCost(3, 1000, 0), 333);
});

test('resolveStockValue：金额按批次原值加总，不吃均价的四舍五入误差', () => {
  // 上海新家实测案例：马桶 1 只 ¥278 + 5 只 ¥280 = ¥1,678.00 整。
  // 均价口径会算成 round(167800/6)=27967 → 6×27967=167802，多出 2 分，客户不认。
  assert.equal(resolveStockValue(6, 6, 167800, 0), 167800);
  // 没批次的老库存：数量 × 参考成本（和以前一致）
  assert.equal(resolveStockValue(4, 0, 0, 250), 1000);
  // 批次只盖住一部分：盖住的按批次值，盖不住的按参考成本兜底
  assert.equal(resolveStockValue(5, 3, 900, 250), 900 + 2 * 250);
});

test('averageUnitCost：按分摊金额合计除以数量四舍五入', () => {
  const allocations = [
    { stockLotId: 1, qty: 2, unitCostCents: 100, amountCents: 200 },
    { stockLotId: 2, qty: 1, unitCostCents: 250, amountCents: 250 },
  ];
  assert.equal(averageUnitCost(allocations, 3), 150);
  assert.equal(averageUnitCost([], 0), 0);
});

test('consumeStockLots：先进先出，跨批次时成本分别取各批单价', async () => {
  const manager = fakeManager();
  await manager.save(Stock, manager.create(Stock, { ...KEY, qty: 8, safetyQty: 0 }));
  const cheap = await seedLot(manager, 5, 100, new Date('2026-01-01'));
  const dear = await seedLot(manager, 3, 180, new Date('2026-02-01'));

  const allocations = await consumeStockLots(manager, { ...KEY, qty: 6, operatorId: 1 });

  assert.deepEqual(allocations, [
    { stockLotId: cheap.id, qty: 5, unitCostCents: 100, amountCents: 500 },
    { stockLotId: dear.id, qty: 1, unitCostCents: 180, amountCents: 180 },
  ]);
  assert.equal(Number(cheap.remainingQty), 0);
  assert.equal(Number(dear.remainingQty), 2);
  // 6 件总成本 680 → 均价 113，历史快照就是这个数，之后再入贵货也不变
  assert.equal(averageUnitCost(allocations, 6), 113);
});

test('consumeStockLots：老库存没批次时补一条 LEGACY 批次，按参考成本、最先被扣', async () => {
  const manager = fakeManager();
  await manager.save(Material, manager.create(Material, { id: KEY.materialId, tenantId: 1, defaultCostCents: 90 }));
  await manager.save(Stock, manager.create(Stock, { ...KEY, qty: 10, safetyQty: 0 }));
  const recent = await seedLot(manager, 4, 200, new Date('2026-03-01'));

  const allocations = await consumeStockLots(manager, { ...KEY, qty: 7, operatorId: 1 });

  const legacy = manager.tables.get(StockLot)!.find((lot) => lot.sourceType === 'legacy_stock');
  assert.ok(legacy, '应补出 LEGACY 批次');
  assert.equal(Number(legacy!.initialQty), 6);
  assert.equal(legacy!.unitCostCents, 90);
  assert.deepEqual(allocations, [
    { stockLotId: legacy!.id, qty: 6, unitCostCents: 90, amountCents: 540 },
    { stockLotId: recent.id, qty: 1, unitCostCents: 200, amountCents: 200 },
  ]);
});

test('consumeStockLots：批次不够时报错，不允许扣成负数', async () => {
  const manager = fakeManager();
  await manager.save(Stock, manager.create(Stock, { ...KEY, qty: 2, safetyQty: 0 }));
  await seedLot(manager, 2, 100, new Date('2026-01-01'));
  await assert.rejects(
    consumeStockLots(manager, { ...KEY, qty: 3, operatorId: 1 }),
    /insufficient/,
  );
});

test('restoreStockLots：冲回后批次剩余原样加回', async () => {
  const manager = fakeManager();
  await manager.save(Stock, manager.create(Stock, { ...KEY, qty: 5, safetyQty: 0 }));
  const lot = await seedLot(manager, 5, 120, new Date('2026-01-01'));
  const allocations = await consumeStockLots(manager, { ...KEY, qty: 4, operatorId: 1 });
  assert.equal(Number(lot.remainingQty), 1);

  await restoreStockLots(manager, allocations, 1);
  assert.equal(Number(lot.remainingQty), 5);
});

/**
 * 库位是 2026-08-30 加的：入库写，出库不动。
 * 「出库不动」这条最容易在以后被顺手改成「跟着最后一笔动」——
 * 那样领完一次料，清单上的库位就变成空值，仓库里的人按清单找不到货。
 */
test('applyStockDelta：入库写库位，出库不动，入库没指定时保留原库位', async () => {
  const manager = fakeManager();
  await applyStockDelta(manager, {
    ...KEY,
    deltaQty: 5,
    type: StockMovementType.INBOUND,
    unitCostCents: 100,
    refType: 'goods_receipt',
    refId: 1,
    operatorId: 1,
    locationId: 11,
  });
  const stock = manager.tables.get(Stock)![0];
  assert.equal(stock.locationId, 11);

  // 出库：东西还在原来那格，不能被清掉
  await applyStockDelta(manager, {
    ...KEY,
    deltaQty: -2,
    type: StockMovementType.OUTBOUND,
    unitCostCents: 100,
    refType: 'work_order',
    refId: 2,
    operatorId: 1,
  });
  assert.equal(stock.locationId, 11);
  assert.equal(Number(stock.qty), 3);

  // 入库但没指定库位（仓库没配默认库位）：保留原来的，不清空
  await applyStockDelta(manager, {
    ...KEY,
    deltaQty: 4,
    type: StockMovementType.INBOUND,
    unitCostCents: 100,
    refType: 'general_receipt',
    refId: 3,
    operatorId: 1,
  });
  assert.equal(stock.locationId, 11);

  // 入库指定了新库位：改过去
  await applyStockDelta(manager, {
    ...KEY,
    deltaQty: 1,
    type: StockMovementType.INBOUND,
    unitCostCents: 100,
    refType: 'transfer_order',
    refId: 4,
    operatorId: 1,
    locationId: 12,
  });
  assert.equal(stock.locationId, 12);
  assert.equal(Number(stock.qty), 8);
});

test('applyStockDelta：改数量并落带成本快照的流水；扣成负数直接拒绝', async () => {
  const manager = fakeManager();
  const stock = await applyStockDelta(manager, {
    ...KEY,
    deltaQty: 3,
    type: StockMovementType.INBOUND,
    unitCostCents: 150,
    refType: 'goods_receipt',
    refId: 7,
    operatorId: 1,
  });
  assert.equal(Number(stock.qty), 3);
  const movements = manager.tables.get(StockMovement)!;
  assert.equal(movements.length, 1);
  assert.equal(movements[0].unitCostCents, 150);
  assert.equal(movements[0].refId, 7);

  await assert.rejects(
    applyStockDelta(manager, {
      ...KEY,
      deltaQty: -4,
      type: StockMovementType.OUTBOUND,
      unitCostCents: 150,
      refType: 'work_order',
      refId: 1,
      operatorId: 1,
    }),
    /insufficient/,
  );
});
