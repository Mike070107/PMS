import test from 'node:test';
import assert from 'node:assert/strict';
import { MisFeesService } from './mis-fees.service';

const now = new Date('2026-11-08T08:00:00+08:00');

test('screenSummary 直连聚合：多小区 scope、无指标时 null、今日/趋势/欠费/近期返回结构', async () => {
  const service: any = Object.create(MisFeesService.prototype);
  const communities = [
    { id: 1, name: '枫桦景苑一期', offices: ['01'] },
    { id: 2, name: '枫桦景苑二期', offices: ['02', '03'] },
  ];
  service.residentialScope = async () => communities;
  service.read = async () => ({ recordsets: [[
    { officeCode: '01', day: '2026-11-08', amount: '300.00', billCount: '3', houseCount: '2' },
    { officeCode: '02', day: '2026-11-08', amount: '200.00', billCount: '2', houseCount: '1' },
    { officeCode: '03', day: '2026-11-07', amount: '100.00', billCount: '1', houseCount: '1' },
  ]] });
  service.dataSource = { query: async () => [] };
  service.residential = async () => ({ total: { count: 4, amountCents: 5000 }, buckets: [{ key: 'le500', count: 4, amountCents: 5000 }] });
  service.recentPayments = async () => ({ rows: [{ address: 'A', amountCents: 30000 }] });
  const result: any = await service.screenSummary({ year: 2026, granularity: 'month' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
  assert.deepEqual(result.scope.communityIds, [1, 2]);
  assert.equal(result.target.annualCents, 0);
  assert.equal(result.target.rate, null);
  assert.equal(result.target.dailyNeedCents, null);
  assert.equal(result.today.paidCents, 50000);
  assert.equal(result.today.billCount, 5);
  assert.equal(result.monthToDate.paidCents, 60000);
  assert.equal(result.trend.length, 12);
  assert.deepEqual(result.arrears.buckets[0], { key: 'le500', count: 4, amountCents: 5000 });
  assert.equal(result.recentPayments.length, 1);
});
