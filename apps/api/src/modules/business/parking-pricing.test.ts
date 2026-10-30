import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTiers, normalizeVehicleClass, priceParking, priceRule, priceTable, targetsOverlap, upgradeToTable } from './parking-pricing';

test('owner car: 150/month, 12 months package 1500', () => {
  const tiers = normalizeTiers([{ months: 12, amountCents: 150000 }]);
  const at = (m: number) => priceParking(m, 15000, tiers).amountCents / 100;
  assert.deepEqual([1, 2, 3, 6, 11, 12, 13, 24].map(at), [150, 300, 450, 900, 1650, 1500, 1650, 3000]);
  assert.equal(priceParking(13, 15000, tiers).breakdown, '12 个月套餐 + 1 个月按月');
  assert.equal(priceParking(24, 15000, tiers).breakdown, '12 个月套餐 ×2');
});

test('11 months never costs more than the 12-month package would suggest only if cheaper by month', () => {
  // 11 个月按月 1650 > 12 个月套餐 1500：系统不擅自多收一个月，只按所选月数计价
  assert.equal(priceParking(11, 15000, [{ months: 12, amountCents: 150000 }]).amountCents, 165000);
});

test('tenant car: 180/month, no package → 2160 a year', () => {
  assert.equal(priceParking(12, 18000).amountCents, 216000);
  assert.equal(priceParking(1, 18000).breakdown, '1 个月按月');
});

test('tier validation', () => {
  assert.throws(() => normalizeTiers([{ months: 0, amountCents: 1 }]), /1~60/);
  assert.throws(() => normalizeTiers([{ months: 12, amountCents: 1 }, { months: 12, amountCents: 2 }]), /重复/);
  assert.deepEqual(normalizeTiers([{ months: 12, amountCents: 1 }, { months: 6, amountCents: 2 }]).map((t) => t.months), [6, 12]);
  assert.equal(normalizeVehicleClass(' 业主 车 '), '业主车');
  assert.throws(() => normalizeVehicleClass('一'.repeat(21)), /20/);
  assert.throws(() => priceParking(0, 100), /1~60/);
});

test('缴费规则分组：按价格表精确取价，表里没有的月数不能收', () => {
  const tiers = normalizeTiers([{ months: 12, amountCents: 150000 }, { months: 1, amountCents: 15000 }, { months: 3, amountCents: 45000 }]);
  assert.deepEqual(tiers.map((t) => t.months), [1, 3, 12]);
  assert.equal(priceTable(12, tiers).amountCents, 150000);
  assert.equal(priceTable(3, tiers).amountCents, 45000);
  assert.throws(() => priceTable(4, tiers), /没有定 4 个月的价格，可选：1、3、12 个月/);
  assert.throws(() => priceTable(1, []), /还没有设价格/);
  assert.equal(priceRule(12, 0, { priceMode: 'table', tiers }).amountCents, 150000);
  // 旧规则仍按单价+套餐
  assert.equal(priceRule(13, 15000, { tiers: [{ months: 12, amountCents: 150000 }] }).amountCents, 165000);
});

test('旧规则升级成价格表：金额与原算法一致，没分类的成为默认分组', () => {
  const up = upgradeToTable({ parkingTarget: 'local:phase1_parking' }, 15000)!;
  assert.equal(up.priceMode, 'table');
  assert.deepEqual(up.tiers, [1, 2, 3, 6, 12].map((m) => ({ months: m, amountCents: 15000 * m })));
  assert.equal(up.vehicleClass, '默认分组');
  assert.equal(up.isDefault, true);
  assert.deepEqual(up.parkingTargets, ['local:phase1_parking']);
  const owner = upgradeToTable({ vehicleClass: '业主车', tiers: [{ months: 12, amountCents: 150000 }] }, 15000)!;
  assert.deepEqual(owner.tiers!.map((x) => [x.months, x.amountCents / 100]), [[1, 150], [2, 300], [3, 450], [6, 900], [12, 1500]]);
  assert.equal(owner.isDefault, undefined);
  assert.equal(upgradeToTable(owner, 15000), null, '已升级的不再动');
});

test('适用车库重叠判断：空 = 全部车库', () => {
  assert.equal(targetsOverlap([], ['a']), true);
  assert.equal(targetsOverlap(['a', 'b'], ['b']), true);
  assert.equal(targetsOverlap(['a'], ['c']), false);
});

test('分组名最长 20 字', () => {
  assert.equal(normalizeVehicleClass(' 小车内场 缴费费率180 '), '小车内场缴费费率180');
  assert.throws(() => normalizeVehicleClass('一'.repeat(21)), /最多 20 个字/);
});
