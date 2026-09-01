import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGeneralReceiptDto, CreateTransferOrderDto } from './dto';

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
