import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessService } from './business.service';
import { BusinessTransaction } from '../../entities';
import { parkingRenewalWindow } from './parking-renewal-window';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompleteBusinessDto, EstimateBusinessDto } from './dto';

test('试算和收款DTO都不能把空白实收转换为0元', async () => {
  for (const Dto of [EstimateBusinessDto, CompleteBusinessDto]) {
    for (const manualAmountCents of ['', ' ', false]) {
      const errors = await validate(plainToInstance(Dto, { serviceType: 'parking_monthly', ruleId: 18, manualAmountCents }));
      assert.ok(errors.some(e => e.property === 'manualAmountCents'), JSON.stringify({ dto: Dto.name, manualAmountCents }));
    }
  }
});

const service: any = Object.create(BusinessService.prototype);
service.today = () => '2026-11-05';
const rule: any = { id: 18, billingUnit: 'month', unitPriceCents: 15000, config: { vehicleClass: '住户车-1', tiers: [{ months: 1, amountCents: 15000 }, { months: 12, amountCents: 150000 }] } };

test('配置的0元价格按真实服务试算保留，不因免费拒绝续期', () => {
  const free = { ...rule, config: { priceMode: 'table', tiers: [{ months: 1, amountCents: 0 }] } };
  assert.equal(service.estimateParking(free, { months: 1, currentEndDate: '2026-11-30' }, 91).amountCents, 0);
  assert.equal(service.estimateParking(free, { months: 1, currentEndDate: '2026-11-30' }, 91).endDate, '2026-12-31');
});

test('自定日期明确实收150元不被缺少2个月标准档位拦截', () => {
  const table = { ...rule, config: { ...rule.config, priceMode: 'table', tiers: [{ months: 12, amountCents: 150000 }] } };
  const result = service.estimateParking(table, { serviceType: 'parking_monthly', startDate: '2026-11-06', endDate: '2026-12-31', manualAmountCents: 15000, customReason: '优惠减免' }, 91);
  assert.equal(result.amountCents, 15000);
  assert.equal(result.standardAmountCents, null, '没有配置标准价必须保留未知，不能编造成0元');
  assert.equal(result.requiresReview, true);
  assert.equal(result.startDate, '2026-11-06');
  assert.equal(result.endDate, '2026-12-31');
});

test('历史分组11个月真实试算与收款重新计算一致，不信任客户端金额', async () => {
  const table = { ...rule, communityId: 1, config: { priceMode: 'table', vehicleClass: '亲情车', tiers: [1,2,3,6,12].map(months => ({ months, amountCents: months === 12 ? 150000 : months * 15000 })) } };
  const before = JSON.stringify(table);
  const svc: any = Object.create(BusinessService.prototype);
  const saved: any[] = [];
  Object.assign(svc, {
    today: () => '2026-11-05',
    ruleRepo: { findOne: async () => table },
    houseRepo: { findOne: async () => ({ id: 1, buildingId: 2 }) },
    buildingRepo: { findOne: async () => ({ id: 2, communityId: 1 }) },
    tagRepo: { findOne: async () => ({ vehicleClass: '亲情车' }) },
    vehicleRepo: { findOne: async () => ({ id: 3, plateNo: '沪TEST01' }), save: async (v: any) => v },
    txnRepo: { create: (v: any) => v, save: async (v: any) => { const row = { id: 40, ...v }; saved.push(row); return row; } },
    logRepo: { create: (v: any) => v, save: async (v: any) => v },
    execution: { initialFor: () => ({ status: 'queued' }), kick: () => {} },
  });
  const dto: any = { serviceType: 'parking_monthly', ruleId: 18, houseId: 1, plateNo: '沪TEST01', months: 11, currentEndDate: '2027-01-31', paymentMethod: 'cash', amountCents: 1 };
  const estimate = svc.estimateParking(table, dto, 91);
  assert.equal(estimate.amountCents, 165000);
  assert.equal(estimate.standardAmountCents, 165000);
  assert.equal(estimate.quantity, 11);
  assert.equal(estimate.startDate, '2027-02-01');
  assert.equal(estimate.endDate, '2027-12-31');
  const result = await svc.complete(dto, { id: 7, tenantId: 91 }, { scopeAll: false, communityIds: [1] });
  assert.equal(saved.length, 1);
  assert.equal(result.amountCents, estimate.amountCents);
  assert.equal(result.quantity, 11);
  assert.equal(JSON.stringify(table), before, '读取、试算、收款均不改配置');
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


test('自定日期明确0元合法，缺价不能替代明确金额和原因', async () => {
  const table = { ...rule, config: { ...rule.config, priceMode: 'table', tiers: [{ months: 12, amountCents: 150000 }] } };
  const dto: any = { serviceType: 'parking_monthly', ruleId: 18, startDate: '2026-11-06', endDate: '2026-12-31', manualAmountCents: 0, customReason: '优惠减免' };
  for (const Dto of [EstimateBusinessDto, CompleteBusinessDto]) {
    assert.equal((await validate(plainToInstance(Dto, dto))).length, 0);
  }
  const result = service.estimateParking(table, dto, 91);
  assert.equal(result.amountCents, 0); assert.equal(result.requiresReview, true); assert.equal(result.standardAmountCents, null);
  for (const invalid of [
    { ...dto, manualAmountCents: undefined }, { ...dto, manualAmountCents: null },
    { ...dto, manualAmountCents: -1 }, { ...dto, manualAmountCents: 0.1 },
    { ...dto, customReason: ' ' }, { ...dto, endDate: '2026-02-30' },
    { ...dto, startDate: undefined }, { ...dto, endDate: undefined },
    { ...dto, startDate: '2027-01-01' }, { ...dto, startDate: undefined, endDate: undefined, months: 1 },
  ]) assert.throws(() => service.estimateParking(table, invalid, 91));
});


test('新办与已有车辆的0元/150元自定日期登记保留待审核，不提前下发停车系统', async () => {
  for (const intake of [false, true]) for (const amount of [0, 15000]) {
    const saved: any[] = [], logs: any[] = []; let kicked = 0, attached = 0, notified = 0;
    const svc: any = Object.create(BusinessService.prototype);
    Object.assign(svc, {
      ruleRepo: { findOne: async () => ({ ...rule, communityId: 1, config: { ...rule.config, priceMode: 'table' } }) },
      houseRepo: { findOne: async () => ({ id: 1, buildingId: 2 }) },
      buildingRepo: { findOne: async () => ({ id: 2, communityId: 1 }) },
      tagRepo: { findOne: async () => ({ vehicleClass: '住户车-1' }) },
      vehicleRepo: { findOne: async () => ({ id: 3, plateNo: '沪TEST01' }), save: async (v: any) => v },
      txnRepo: { create: (v: any) => v, save: async (v: any) => { const row = { id: 40, ...v }; saved.push(row); return row; } },
      logRepo: { create: (v: any) => v, save: async (v: any) => { logs.push(...v); return v; } },
      intakes: { withPaymentTransaction: async (_id: number, _user: any, _access: any, work: any) => work({ getRepository: (entity: any) => entity === BusinessTransaction ? svc.txnRepo : svc.logRepo }), claimForPayment: async () => ({ row: { id: 5, vehicleClass: '住户车-1' }, plate: '沪TEST01', approved: true }), attachPayment: async () => { attached++; } },
      execution: { initialFor: () => ({ status: 'queued' }), kick: () => { kicked++; } },
      notifyReviewers: async () => { notified++; },
    });
    const result = await svc.complete({ serviceType: 'parking_monthly', ruleId: 18, houseId: 1, plateNo: '沪TEST01', startDate: '2026-11-06', endDate: '2026-12-31', manualAmountCents: amount, customReason: '优惠减免', paymentMethod: 'cash', ...(intake ? { intakeId: 5 } : {}) }, { id: 7, tenantId: 91 }, { scopeAll: false, communityIds: [1] });
    assert.equal(saved.length, 1); assert.equal(result.amountCents, amount); assert.equal(result.externalSyncStatus, 'review');
    assert.equal(result.snapshot.review.standardAmountCents, 30000); assert.equal(result.snapshot.review.manualAmountCents, amount);
    assert.ok(logs.some(v => v.action === 'review_requested')); assert.equal(kicked, 0); assert.equal(notified, 1); assert.equal(attached, intake ? 1 : 0);
  }
});


test('收费标准保存月单价及满减设置，六类规则覆盖1至60个月且试算不改价格配置', () => {
  for (const [name, monthlyPriceCents, discountMonths] of [
    ['住户车-1',15000,2], ['住户车-2',15000,0], ['住户车-3',25000,0],
    ['租户车-1',15000,0], ['租户车-2',25000,0], ['产权车位',6750,0],
  ] as const) {
    const dto: any = { serviceType: 'parking_monthly', billingUnit: 'month', name, unitPriceCents: 0, config: { priceMode: 'monthly', vehicleClass: name, monthlyPriceCents, discountCycleMonths: 12, discountMonths } };
    service.assertRuleShape(dto);
    assert.equal(dto.unitPriceCents, monthlyPriceCents); assert.equal(dto.config.priceMode,'monthly');
    const serialized = JSON.stringify(dto.config);
    for (let m=1;m<=60;m++) {
      const quote=service.estimateParking({ ...rule, unitPriceCents:dto.unitPriceCents, config:dto.config }, { serviceType:'parking_monthly', months:m }, 91);
      assert.equal(quote.amountCents, monthlyPriceCents*(m-Math.floor(m/12)*discountMonths), name+' / '+m);
    }
    assert.equal(JSON.stringify(dto.config),serialized);
  }
});
