import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { InventoryService } from './inventory.service';
import { StockQueryDto } from './dto';

function fixture() {
  const service: any = Object.create(InventoryService.prototype);
  service.resolveTenantId = () => 1;
  service.visibleWarehouseIds = async () => [2];
  service.warehouseIdsOfType = async () => undefined;
  const stocks = [0, 2, -1].map((qty, index) => ({ id: index + 1, warehouseId: 2, materialId: index + 1, qty, safetyQty: 1 }));
  service.stockRepo = { find: async () => stocks };
  service.materialRepo = { find: async () => stocks.map(s => ({ id: s.materialId, name: `材料${s.id}`, defaultCostCents: 0 })) };
  const qb: any = {};
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'addGroupBy']) qb[method] = () => qb;
  qb.getRawMany = async () => [];
  service.dataSource = { manager: { createQueryBuilder: () => qb }, query: async () => [] };
  return service;
}

test('有货筛选在分页前生效，显式关闭仍可查零库存预警', async () => {
  const service = fixture();
  const user: any = { tenantId: 1, id: 7 };
  const rows = await service.listStocks({ onlyStocked: true, pageSize: 1, sort: 'qty', dir: 'asc' }, user);
  assert.deepEqual(rows.map((r: any) => Number(r.qty)), [2]);
  const all = await service.listStocks({ onlyStocked: false }, user);
  assert.equal(all.length, 3);
  const low = await service.listStocks({ lowOnly: true }, user);
  assert.equal(low.length, 2);
});

test('有货筛选 query 正确转换 true/false/1/0', () => {
  for (const value of [true, 'true', '1', 1]) assert.equal(plainToInstance(StockQueryDto, { onlyStocked: value }).onlyStocked, true);
  for (const value of [false, 'false', '0', 0]) assert.equal(plainToInstance(StockQueryDto, { onlyStocked: value }).onlyStocked, false);
});
