import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessService } from './business.service';
import { parkingRenewalWindow } from './parking-renewal-window';

const service: any = Object.create(BusinessService.prototype);
service.today = () => '2026-11-05';
const rule: any = { id: 18, billingUnit: 'month', unitPriceCents: 15000, config: { vehicleClass: '住户车-1', tiers: [{ months: 1, amountCents: 15000 }, { months: 12, amountCents: 150000 }] } };

test('配置的0元价格按真实服务试算保留，不因免费拒绝续期', () => {
  const free = { ...rule, config: { priceMode: 'table', tiers: [{ months: 1, amountCents: 0 }] } };
  assert.equal(service.estimateParking(free, { months: 1, currentEndDate: '2026-11-30' }, 91).amountCents, 0);
  assert.equal(service.estimateParking(free, { months: 1, currentEndDate: '2026-11-30' }, 91).endDate, '2026-12-31');
});

test('日期边界与合法月份范围', () => {
  for (const [today, end] of [['2026-11-10', '2026-11-30'], ['2026-11-11', '2026-12-31']]) {
    assert.equal(parkingRenewalWindow({ today, months: 1 }).endDate, end);
  }
  for (const months of [0, 1.5, 61]) assert.throws(() => parkingRenewalWindow({ today: '2026-11-05', months }));
  assert.throws(() => parkingRenewalWindow({ today: '2026-02-30', months: 1 }));
});

test('真实服务试算按规则减免，但实际续期月数不减少', () => {
  for (const [months, expected] of [[1,15000],[3,45000],[6,90000],[11,165000],[12,150000],[13,165000],[24,300000]]) {
    const result = service.estimateParking(rule, { serviceType: 'parking_monthly', months, currentEndDate: '2027-01-31' }, 91);
    assert.equal(result.amountCents, expected);
    assert.equal(result.quantity, months);
    assert.equal(result.startDate, '2027-02-01');
    assert.equal(result.vehicleClass, '住户车-1');
    assert.equal(result.tenantId, 91);
  }
});

test('真实服务拒绝非法月份及无月价时的未配置档位', () => {
  for (const months of [0, 1.5, 61]) {
    assert.throws(() => service.estimateParking(rule, { months }, 91), (e: any) => e.getStatus() === 400);
  }
  const annual = { ...rule, config: { ...rule.config, priceMode: 'table', tiers: [{ months: 12, amountCents: 150000 }] } };
  assert.throws(() => service.estimateParking(annual, { months: 3 }, 91), (e: any) => e.getStatus() === 400);
});
