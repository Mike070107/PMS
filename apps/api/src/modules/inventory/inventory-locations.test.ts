import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { buildLocationBreakdown } from './stock-locations.util';

function fixture(stockReferences = 0) {
  const rows: any[] = [];
  let nextId = 1;
  const repo: any = {
    findOne: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
    create: (data: any) => ({ id: nextId, ...data }),
    save: async (row: any) => { const stored = { ...row, id: row.id || nextId++ }; const index = rows.findIndex((item) => item.id === stored.id); if (index >= 0) rows[index] = stored; else rows.push(stored); return stored; },
    find: async ({ where }: any) => rows.filter((row) => Object.entries(where || {}).every(([key, value]) => row[key] === value)),
    delete: async ({ id }: any) => { const index = rows.findIndex((row) => row.id === id); if (index >= 0) rows.splice(index, 1); return { affected: index >= 0 ? 1 : 0 }; },
  };
  const service: any = Object.create(InventoryService.prototype);
  service.resolveTenantId = () => 1;
  service.assertWarehouseVisible = async () => undefined;
  service.visibleWarehouseIds = async () => [2];
  service.ensureWarehouse = async () => undefined;
  service.stockRepo = { count: async () => stockReferences };
  service.dataSource = { getRepository: () => repo, manager: {} };
  return { service, rows };
}

test('库位 CRUD：自动 label、同仓唯一、更新改名、停用列表', async () => {
  const { service, rows } = fixture();
  const created: any = await service.createWarehouseLocation({ warehouseId: 2, zone: 'A', shelf: '03', bin: '2' }, { id: 7, tenantId: 1 });
  assert.equal(created.label, 'A-03-2');
  await assert.rejects(() => service.createWarehouseLocation({ warehouseId: 2, zone: 'A', shelf: '03', bin: '2' }, { id: 7, tenantId: 1 }), /不能重复/);
  const updated: any = await service.updateWarehouseLocation(created.id, { label: 'A架-3层' }, { id: 7, tenantId: 1 });
  assert.equal(updated.label, 'A架-3层');
  assert.equal(rows.length, 1);
  await service.updateWarehouseLocation(created.id, { enabled: false }, { id: 7, tenantId: 1 });
  assert.equal(rows[0].enabled, false);
  const enabled = await service.listWarehouseLocations({ enabled: true }, { id: 7, tenantId: 1 });
  assert.equal(enabled.length, 0); // 已停用，不再出现在“启用”筛选里
});

test('库位删除：有库存引用拒绝，无引用成功', async () => {
  const blocked = fixture(2);
  const location: any = await blocked.service.createWarehouseLocation({ warehouseId: 2, zone: 'B', shelf: '1' }, { id: 7, tenantId: 1 });
  await assert.rejects(() => blocked.service.deleteWarehouseLocation(location.id, { id: 7, tenantId: 1 }), /仍有库存/);
  const free = fixture(0);
  const location2: any = await free.service.createWarehouseLocation({ warehouseId: 2, zone: 'C', shelf: '1' }, { id: 7, tenantId: 1 });
  assert.deepEqual(await free.service.deleteWarehouseLocation(location2.id, { id: 7, tenantId: 1 }), { deleted: 1 });
});

test('按货架聚合：同材料多库位数量，未覆盖部分归未分配', () => {
  const labels = new Map([[11, 'A架'], [12, 'B架']]);
  assert.deepEqual(buildLocationBreakdown(5, new Map<number | null, number>([[11, 3], [12, 2]]), labels), [
    { locationId: 11, label: 'A架', qty: 3 },
    { locationId: 12, label: 'B架', qty: 2 },
  ]);
  assert.deepEqual(buildLocationBreakdown(6, new Map<number | null, number>([[11, 3]]), labels), [
    { locationId: 11, label: 'A架', qty: 3 },
    { locationId: null, label: '未分配', qty: 3 },
  ]);
  assert.deepEqual(buildLocationBreakdown(5, new Map(), labels), [{ locationId: null, label: '未分配', qty: 5 }]);
});

test('GET /stocks/:id/lots 同时返回批次与流水，入库流水带来源单号和库位', async () => {
  const { service } = fixture();
  service.stockRepo = { findOne: async () => ({ id: 74, tenantId: 1, warehouseId: 2, materialId: 69 }) };
  service.dataSource = {
    getRepository: () => ({ find: async () => [{ id: 3, lotNo: 'L1', remainingQty: 5 }] }),
    manager: {},
  };
  service.listStockMovements = async () => [{ id: 127, type: 'inbound', qty: 5, refNo: 'GR-20261109-05054099', locationLabel: null }];
  const result: any = await service.listStockLots(74, { id: 7, tenantId: 1 }, { scopeAll: true } as any);
  assert.equal(result.lots.length, 1);
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0].refNo, 'GR-20261109-05054099');
});
