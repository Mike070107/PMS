import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCashierContact, normalizeCashierContact, normalizeCashierItems } from './cashier.util';

test('收费台只保存非空的住户姓名和手机号', () => {
  assert.deepEqual(normalizeCashierContact('  张三  ', ' 13800138000 '), {
    name: '张三',
    phone: '13800138000',
  });
  assert.deepEqual(normalizeCashierContact('   ', '   '), { name: null, phone: null });
});

test('收费台空输入不清除 PMS 已有住户资料', () => {
  assert.deepEqual(
    mergeCashierContact(
      { name: '原姓名', phone: '13800138000' },
      normalizeCashierContact('', '13900139000'),
    ),
    { name: '原姓名', phone: '13900139000' },
  );
});

test('收费项目按数量和单价校验金额并保留业务明细', () => {
  assert.deepEqual(
    normalizeCashierItems([
      {
        feeCode: 'electricity',
        quantity: 12.5,
        unit: '度',
        unitPriceCents: 80,
        amountCents: 1000,
      },
    ]),
    [
      {
        feeCode: 'electricity',
        quantity: '12.500',
        unit: '度',
        unitPriceCents: 80,
        amountCents: 1000,
        serviceFrom: null,
        serviceTo: null,
        vehiclePlate: null,
        remark: null,
      },
    ],
  );
});

test('允许实收金额与数量乘单价不同并保留实收快照', () => {
  const [item] = normalizeCashierItems([
    { feeCode: 'electricity', quantity: 10, unitPriceCents: 80, amountCents: 750 },
  ]);
  assert.equal(item.amountCents, 750);
});
