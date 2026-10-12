import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSync } from 'class-validator';
import { CashierChargeItemDto } from './dto';
import { FeesService } from './fees.service';
import { House, User } from '../../entities';
import {
  assertReceiptRefundable,
  markRefundedRemark,
  mergeCashierContact,
  normalizeCashierContact,
  normalizeCashierItems,
  reversalRemark,
} from './cashier.util';

test('退费项目允许负数金额，普通收费与退费可同单保存', () => {
  const refund = Object.assign(new CashierChargeItemDto(), { feeCode: 'deposit', quantity: 1, unitPriceCents: 3000, amountCents: -3000 });
  assert.deepEqual(validateSync(refund), []);
  const rows = normalizeCashierItems([{ feeCode: 'rent', amountCents: 10000 }, refund]);
  assert.equal(rows[1].amountCents, -3000);
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 7000);
});

test('自动保存与收费复用住户写入：只更新指定字段，允许清空，失败不写入', async () => {
  const service = Object.create(FeesService.prototype) as any;
  let owner: any = { id: 1, name: '原姓名', phone: '13800000000' };
  let writes = 0;
  let duplicate = false;
  const manager = {
    findOne: async (entity: any, query: any) => {
      if (entity === House) return { id: 10 };
      if (query.where.phone) return duplicate ? { id: 2 } : null;
      return owner ? { ...owner } : null;
    },
    create: (_entity: any, row: any) => ({ id: 1, ...row }),
    save: async (entity: any, row: any) => { assert.equal(entity, User); writes++; owner = { ...row }; return owner; },
  };
  service.requireTenant = () => 7;
  service.resolveHousePlace = async () => ({ communityId: 20 });
  service.assertCommunityInScope = () => {};
  service.dataSource = { transaction: async (callback: any) => callback(manager) };
  const result = await service.updateCashierContact(10, { ownerId: 1, ownerName: ' 新姓名 ' }, { id: 3 });
  assert.deepEqual(result.owner, { id: 1, name: '新姓名', phone: '13800000000' });
  await service.updateCashierContact(10, { ownerPhone: '' }, { id: 3 });
  assert.equal(owner.phone, null);
  assert.equal(owner.name, '新姓名');
  duplicate = true;
  await assert.rejects(() => service.updateCashierContact(10, { ownerPhone: '13900000000' }, { id: 3 }), /另一位业主/);
  assert.equal(writes, 2);
  assert.equal(owner.phone, null);
  service.assertCommunityInScope = () => { throw new Error('超出数据范围'); };
  await assert.rejects(() => service.updateCashierContact(10, { ownerName: '越权' }, { id: 3 }), /超出数据范围/);
  assert.equal(writes, 2);
});

test('没有住户时补录只创建一次，后续保存继续更新同一住户', async () => {
  const service = Object.create(FeesService.prototype) as any;
  let owner: any = null;
  let creates = 0;
  const manager = {
    findOne: async (entity: any, query: any) => entity === House ? { id: 10 } : query.where.phone ? null : owner,
    create: (_entity: any, row: any) => { creates++; return { ...row, id: 8 }; },
    save: async (_entity: any, row: any) => { owner = row; return row; },
  };
  await service.saveCashierContact(manager, { houseId: 10, ownerName: '测试' }, { id: 3 }, 7, true);
  await service.saveCashierContact(manager, { houseId: 10, ownerPhone: '13800000000' }, { id: 3 }, 7, true);
  assert.equal(creates, 1);
  assert.equal(owner.name, '测试');
  assert.equal(owner.phone, '13800000000');
});

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
