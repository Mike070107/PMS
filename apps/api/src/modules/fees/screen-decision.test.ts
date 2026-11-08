import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenSummary } from './screen-summary.util';

const now = new Date('2026-11-08T12:00:00+08:00');
function run(extra: Record<string, unknown> = {}) {
  return buildScreenSummary({ year: 2026, now, granularity: 'day',
    communities: [{ id: 1, name: 'A', offices: ['01'] }],
    targets: [{ id: 1, communityIds: [1], feeCode: 'property', year: 2026,
      annualCents: 1200000, monthCents: Array(12).fill(100000) }],
    dailyRows: [{ officeCode: '01', day: '2026-11-07', paidCents: 28000, billCount: 1, houseCount: 1 },
      { officeCode: '01', day: '2026-11-08', paidCents: 999999, feeCode: 'parking', billCount: 1, houseCount: 1 }],
    arrears: { totalCents: 0, houseCount: 0, buckets: [] }, recentPayments: [], ...extra,
  } as any) as any;
}
test('决策指标按考核费项计算；使用完整28天，今日未结束不计入速度', () => {
  const d = run().decision;
  assert.equal(d.recentDailyCents, 1000);
  assert.equal(d.plannedToDateCents, 1026667);
  assert.equal(d.behindCents, 998667);
  assert.equal(d.forecastCents, 81000);
  assert.equal(d.projects[0].communityId, 1);
  assert.equal(d.planSource, 'explicit');
});
test('历史年不预测；无目标无达成率；均摊标为参考', () => {
  assert.equal(run({ year: 2025 }).decision.forecastCents, null);
  assert.equal(run({ targets: [] }).decision.forecastCents, null);
  assert.equal(run({ targets: [] }).decision.plannedToDateCents, null);
  const targets = [{ id: 1, communityIds: [1], feeCode: 'property', year: 2026, annualCents: 1200000, monthCents: Array(12).fill(null) }];
  assert.equal(run({ targets }).decision.planSource, 'derived');
});
test('超额完成所需日均为0；尚未发生的收款不能混入当前累计', () => {
  const r = run({ dailyRows: [{ officeCode: '01', day: '2026-11-07', paidCents: 1300000, billCount: 1, houseCount: 1 },
    { officeCode: '01', day: '2026-12-31', paidCents: 9999999, billCount: 1, houseCount: 1 }] });
  assert.equal(r.target.yearToDateCents, 1300000);
  assert.equal(r.decision.requiredDailyCents, 0);
});

test('未来年度不画虚构实收；月度计划曲线保留季节性', () => {
  assert.equal(run({ year: 2027 }).trend.length, 0);
  const targets = [{ id: 1, communityIds: [1], feeCode: 'property', year: 2026,
    annualCents: 1200000, monthCents: [500000, ...Array(10).fill(50000), 200000] }];
  const d = run({ targets }).decision;
  assert.equal(d.planCurve[0].plannedCents, 500000);
  assert.equal(d.planCurve[10].plannedCents, 1000000);
  assert.equal(d.planCurve[11].plannedCents, 1200000);
});
