import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReceiptRefundable,
  markRefundedRemark,
  mergeCashierContact,
  normalizeCashierContact,
  normalizeCashierItems,
  reversalRemark,
} from './cashier.util';

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

test('只有已收款的收据能红冲，且不能重复红冲', () => {
  assert.doesNotThrow(() => assertReceiptRefundable([{ status: 'paid' }, { status: 'paid' }]));
  assert.throws(() => assertReceiptRefundable([{ status: 'paid' }, { status: 'refunded' }]), /已经红冲过/);
  assert.throws(() => assertReceiptRefundable([{ status: 'unpaid' }]), /只有已收款/);
  assert.throws(() => assertReceiptRefundable([{ status: 'cancelled' }]), /只有已收款/);
});

test('红冲收据备注带原收据号和原因', () => {
  assert.equal(reversalRemark('SJ202610100001', ' 付款方式填错 '), '红冲 SJ202610100001；付款方式填错');
  assert.equal(reversalRemark('SJ202610100001'), '红冲 SJ202610100001');
  assert.equal(reversalRemark('SJ202610100001', '   '), '红冲 SJ202610100001');
});

test('原收据追加红冲标记且不重复追加', () => {
  assert.equal(markRefundedRemark('住户现金'), '住户现金【已被红冲】');
  assert.equal(markRefundedRemark(null), '【已被红冲】');
  assert.equal(markRefundedRemark('住户现金【已被红冲】'), '住户现金【已被红冲】');
});
