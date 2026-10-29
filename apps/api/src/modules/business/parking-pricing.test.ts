import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTiers, normalizeVehicleClass, priceParking } from './parking-pricing';

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
  assert.throws(() => normalizeTiers([{ months: 0, amountCents: 1 }]), /1~36/);
  assert.throws(() => normalizeTiers([{ months: 12, amountCents: 1 }, { months: 12, amountCents: 2 }]), /重复/);
  assert.deepEqual(normalizeTiers([{ months: 12, amountCents: 1 }, { months: 6, amountCents: 2 }]).map((t) => t.months), [6, 12]);
  assert.equal(normalizeVehicleClass(' 业主 车 '), '业主车');
  assert.throws(() => normalizeVehicleClass('一二三四五六七八九十一二三'), /12/);
  assert.throws(() => priceParking(0, 100), /1~60/);
});
