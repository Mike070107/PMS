import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGeneralReceiptDto, CreateTransferOrderDto } from './dto';
import { InventoryService } from './inventory.service';

test('入库单逐行校验，负数量和负单价不能穿过外层 DTO', async () => {
  const dto = plainToInstance(CreateGeneralReceiptDto, {
    warehouseId: 1,
    sourceText: '测试入库',
    items: [{ materialId: 2, qty: -5, unitCostCents: -100 }],
  });
  const errors = await validate(dto);
  assert.ok(errors.some((error) => error.property === 'items'));
  assert.equal(dto.items[0] instanceof Object, true);
});

test('调拨单不允许空明细，正常正数量可以通过', async () => {
  const empty = plainToInstance(CreateTransferOrderDto, {
    fromWarehouseId: 1,
    toWarehouseId: 2,
    items: [],
  });
  assert.ok((await validate(empty)).some((error) => error.property === 'items'));

  const valid = plainToInstance(CreateTransferOrderDto, {
    fromWarehouseId: 1,
    toWarehouseId: 2,
    items: [{ materialId: 3, qty: 1 }],
  });
  assert.deepEqual(await validate(valid), []);
});

test('全公司权限人员的仓库列表仍把本人显式所属管理处排在最前', async () => {
  const svc = Object.create(InventoryService.prototype) as any;
  svc.accessService = {
    async userOfficeIds() { return { all: true, officeIds: [8] }; },
  };
  const rows = [
    { id: 1, officeId: 3 },
    { id: 2, officeId: null },
    { id: 3, officeId: 8 },
  ];

  const result = await svc.filterWarehousesForUser(1, 10, rows);
  assert.deepEqual(result.map((row: any) => row.id), [3, 1, 2]);
});

test('单管理处范围只保留本处仓与明确额外授权仓', async () => {
  const svc = Object.create(InventoryService.prototype) as any;
  svc.accessService = {
    async userOfficeIds() { return { all: false, officeIds: [8] }; },
    async extraWarehouseIdsOfUser() { return [4]; },
  };
  const rows = [
    { id: 1, officeId: 3 },
    { id: 2, officeId: null },
    { id: 3, officeId: 8 },
    { id: 4, officeId: 9 },
  ];

  const result = await svc.filterWarehousesForUser(1, 10, rows);
  assert.deepEqual(result.map((row: any) => row.id), [3, 4]);
});
