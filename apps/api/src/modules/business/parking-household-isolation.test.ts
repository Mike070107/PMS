import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessService } from './business.service';

function harness(houseId: number | null = 15) {
  const service: any = Object.create(BusinessService.prototype);
  const vehicle = { id: 3, tenantId: 1, plateNo: '沪M03212', houseId, ownerId: 5, validUntil: '2027-12-31', updatedBy: 9 };
  const writes: string[] = [];
  Object.assign(service, {
    today: () => '2026-11-17',
    ruleRepo: { findOne: async () => ({ id: 18, communityId: 1, name: '停车', billingUnit: 'month', unitPriceCents: 15000, config: {} }) },
    houseRepo: { findOne: async () => ({ id: 1074, buildingId: 2 }) },
    buildingRepo: { findOne: async () => ({ id: 2, communityId: 1 }) },
    tagRepo: { findOne: async () => null },
    vehicleRepo: { findOne: async () => vehicle, create: (v: any) => v, save: async (v: any) => { writes.push('vehicle'); return v; } },
    txnRepo: { create: (v: any) => v, save: async (v: any) => { writes.push('transaction'); return { id: 40, ...v }; } },
    logRepo: { create: (v: any) => v, save: async (v: any) => { writes.push('audit'); return v; } },
    execution: { initialFor: () => ({ status: 'queued' }), kick: () => writes.push('dispatch') },
  });
  return { service, vehicle, writes };
}
const dto = { serviceType: 'parking_monthly', ruleId: 18, houseId: 1074, plateNo: '沪M03212', months: 6, currentEndDate: '2027-12-31', paymentMethod: 'cash' };

test('跨户续费在车辆、流水、审计及派发写入前拒绝，原归属及有效期保持不变', async () => {
  for (const vehicleId of [undefined, 3]) {
    const h = harness(); const before = JSON.stringify(h.vehicle);
    await assert.rejects(h.service.complete({ ...dto, vehicleId }, { id: 7, tenantId: 1 }, { scopeAll: false, communityIds: [1] }), /房号|住户/);
    assert.equal(JSON.stringify(h.vehicle), before);
    assert.deepEqual(h.writes, []);
  }
});

test('车辆ID与所提交车牌不一致时不能给另一辆车收费', async () => {
  const h = harness(1074); const before = JSON.stringify(h.vehicle);
  await assert.rejects(h.service.complete({ ...dto, vehicleId: 3, plateNo: '沪A216P4' }, { id: 7, tenantId: 1 }), /车牌/);
  assert.equal(JSON.stringify(h.vehicle), before); assert.deepEqual(h.writes, []);
});

test('同户正常续费仍保存车辆、流水、审计并派发一次', async () => {
  const h = harness(1074);
  const result = await h.service.complete({ ...dto }, { id: 7, tenantId: 1 });
  assert.equal(result.houseId, 1074); assert.equal(result.amountCents, 90000);
  assert.deepEqual(h.writes, ['vehicle', 'transaction', 'audit', 'dispatch']);
});

test('旧档案尚无本地房号时保留首次关联能力', async () => {
  const h = harness(null);
  await h.service.upsertVehicle({ ...dto }, 1, 7, '2028-06-30');
  assert.equal(h.vehicle.houseId, 1074); assert.deepEqual(h.writes, ['vehicle']);
});
