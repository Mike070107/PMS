import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairsService } from './repairs.service';
import { WorkOrderStatus } from '../../common/enums';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveMaterialDraftDto } from './dto';
import { Material, Stock } from '../../entities';
import { StockReservation, WorkOrderMaterialDraft } from '../../entities/work-order-material-draft.entity';

test('两张工单只能预留可用库存，删除后另一张可以使用；旧版本不能覆盖草稿', async () => {
  const tables = new Map<any, any[]>([
    [Stock, [{ tenantId: 1, warehouseId: 10, materialId: 20, qty: 5 }]],
    [Material, [{ id: 20, tenantId: 1, enabled: true }]],
    [StockReservation, []], [WorkOrderMaterialDraft, []],
  ]);
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const manager: any = {
    findOne: async (entity: any, options: any) => (tables.get(entity) || []).find((row) => matches(row, options.where)) || null,
    find: async (entity: any, options: any) => (tables.get(entity) || []).filter((row) => matches(row, options.where)),
    create: (_entity: any, row: any) => ({ ...row }),
    save: async (entity: any, row: any) => {
      const rows = tables.get(entity)!;
      if (!rows.includes(row)) rows.push(row);
      return row;
    },
    delete: async (entity: any, where: any) => {
      const rows = tables.get(entity)!;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
    },
  };
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => undefined;
  service.ensureAssigneeOrAdmin = async () => undefined;
  service.lockWorkOrder = async (_manager: any, id: number) => ({ id, status: WorkOrderStatus.IN_PROGRESS });
  service.listWorkOrderStockOptions = async (_id: number, _user: any, _access: any, warehouseId: number) => ({ warehouseId });
  service.dataSource = { transaction: async (fn: (manager: any) => Promise<any>) => fn(manager) };
  const user = { id: 9, tenantId: 1 };
  const row = { materialId: 20, warehouseId: 10, name: '电源', qty: 3, note: '换新' };
  const a = await service.saveMaterialDraft(1, { version: 0, rows: [row] }, user);
  const b = await service.saveMaterialDraft(2, { version: 0, rows: [row] }, user);
  assert.equal(a.rows[0].stockQty, 3);
  assert.equal(b.rows[0].stockQty, 2);
  await assert.rejects(service.saveMaterialDraft(1, { version: 0, rows: [] }, user), /其他设备/);
  await service.saveMaterialDraft(1, { version: a.version, rows: [] }, user);
  const refreshed = await service.saveMaterialDraft(2, { version: b.version, rows: [row] }, user);
  assert.equal(refreshed.rows[0].stockQty, 3);
  assert.equal(refreshed.rows[0].note, '换新');
});

test('完工只能消费已保存的预留，内容不一致时保留预留', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  const draft = { rows: [{ materialId: 20, warehouseId: 10, qty: 2, stockQty: 2, note: '换新' }] };
  const deleted: any[] = [];
  const manager = {
    findOne: async () => draft,
    delete: async (...args: any[]) => { deleted.push(args); },
  };
  await assert.rejects(service.releaseMaterialDraft(manager, 1, 1, [{ materialId: 20, warehouseId: 10, qty: 1, note: '换新' }], false), /草稿已变更/);
  assert.equal(deleted.length, 0);
  await service.releaseMaterialDraft(manager, 1, 1, [{ materialId: 20, warehouseId: 10, qty: 2, note: '换新' }], false);
  assert.deepEqual(deleted.map((item) => item[0]), [StockReservation, WorkOrderMaterialDraft]);
});

test('保存草稿的正式 DTO 接受材料图片，拒绝非法数量和超过十条', async () => {
  const valid = plainToInstance(SaveMaterialDraftDto, { version: 0, rows: [{ materialId: 20, warehouseId: 10, name: '电源', qty: 1, photoUrls: ['a', 'b', 'c', 'd'] }] });
  assert.equal((await validate(valid, { whitelist: true, forbidNonWhitelisted: true })).length, 0);
  const invalid = plainToInstance(SaveMaterialDraftDto, { version: 0, rows: Array.from({ length: 11 }, () => ({ qty: -1 })) });
  assert.ok((await validate(invalid)).length > 0);
});

test('作废或撤单前必须先删除锁定用料，避免形成无法释放的孤儿库存', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  await assert.rejects(service.assertNoReservedMaterial({ count: async () => 1 }, 1, 1), /先删除用料/);
  await assert.doesNotReject(service.assertNoReservedMaterial({ count: async () => 0 }, 1, 1));
});
