import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenSummary } from './screen-summary.util';

const now = new Date('2026-11-08T08:00:00+08:00');

test('收费大屏：多小区合并、达成率/缺口/日均、指标为0时 rate=null', () => {
  const communities = [
    { id: 1, name: '枫桦景苑一期', offices: ['01'] },
    { id: 2, name: '枫桦景苑二期', offices: ['02', '03'] },
  ];
  const targets = [
    { id: 1, communityIds: [1], year: 2026, annualCents: 1_000_000, monthCents: Array(12).fill(100_000) },
    { id: 2, communityIds: [2], year: 2026, annualCents: 500_000, monthCents: Array(12).fill(50_000) },
  ];
  const dailyRows = [
    { officeCode: '01', day: '2026-11-08', paidCents: 30_000, billCount: 3, houseCount: 2 },
    { officeCode: '02', day: '2026-11-08', paidCents: 20_000, billCount: 2, houseCount: 1 },
    { officeCode: '03', day: '2026-11-08', paidCents: 10_000, billCount: 1, houseCount: 1 },
    { officeCode: '01', day: '2026-11-07', paidCents: 10_000, billCount: 1, houseCount: 1 },
  ];
  const result: any = buildScreenSummary({
    year: 2026, communities, targets, dailyRows, granularity: 'month', now,
    arrears: { totalCents: 4_128_388, houseCount: 1_399, buckets: [{ key: 'le500', count: 103, amountCents: 2_493_010 }] },
    recentPayments: [{ address: 'A' }],
  });
  assert.deepEqual(result.scope, { communityIds: [1, 2], communityNames: ['枫桦景苑一期', '枫桦景苑二期'] });
  assert.equal(result.target.annualCents, 1_500_000);
  assert.equal(result.target.yearToDateCents, 70_000);
  assert.equal(result.target.rate, 4.7);
  assert.equal(result.target.gapCents, 1_430_000);
  assert.equal(result.target.remainingDays, 54);
  assert.equal(result.target.dailyNeedCents, 26_481);
  assert.equal(result.partial, false);
  assert.deepEqual(result.targetScope, { communityIds: [1, 2], communityNames: ['枫桦景苑一期', '枫桦景苑二期'] });
  assert.deepEqual(result.missingTargetCommunities, []);
  assert.equal(result.today.paidCents, 60_000);
  assert.equal(result.today.billCount, 6);
  assert.equal(result.today.vsDailyNeed, 226.6);
  assert.equal(result.monthToDate.paidCents, 70_000);
  assert.equal(result.monthToDate.targetCents, 150_000);
  assert.equal(result.monthToDate.rate, 46.7);
  assert.equal(result.monthToDate.targetSource, 'explicit');
  assert.equal(result.monthToDate.month, '2026-11');
  assert.deepEqual(result.communities.map((row: any) => [row.communityId, row.targetCents, row.paidCents, row.rate]), [[1, 1_000_000, 40_000, 4], [2, 500_000, 30_000, 6]]);
  assert.equal(result.trend.length, 12);
  assert.equal(result.trend[10].key, '2026-11');
  assert.equal(result.trend[10].paidCents, 70_000);
  assert.equal(result.arrears.totalCents, 4_128_388);
  assert.equal(result.recentPayments.length, 1);
});

test('收费大屏：未设指标时 annualCents=0、rate/dailyNeed=null，不显示 0%', () => {
  const result: any = buildScreenSummary({
    year: 2026,
    communities: [{ id: 1, name: 'A', offices: ['01'] }],
    targets: [], dailyRows: [{ officeCode: '01', day: '2026-11-08', paidCents: 100, billCount: 1, houseCount: 1 }],
    arrears: { totalCents: 0, houseCount: 0, buckets: [] }, recentPayments: [], now,
  });
  assert.equal(result.target.annualCents, 0);
  assert.equal(result.target.rate, null);
  assert.equal(result.target.dailyNeedCents, null);
  assert.equal(result.partial, true);
  assert.deepEqual(result.targetScope, { communityIds: [], communityNames: [] });
  assert.deepEqual(result.missingTargetCommunities, [{ id: 1, name: 'A' }]);
  assert.equal(result.monthToDate.targetCents, 0);
  assert.equal(result.monthToDate.rate, null);
  assert.equal(result.monthToDate.targetSource, null);
  assert.equal(result.monthToDate.month, '2026-11');
  assert.equal(result.today.vsDailyNeed, null);
  assert.equal(result.communities[0].rate, null);
});

test('收费大屏月度目标：显式 monthCents 优先，null 回退 annual/12；多组求和', () => {
  const communities = [
    { id: 1, name: 'A', offices: ['01'] },
    { id: 2, name: 'B', offices: ['02'] },
  ];
  const row = [{ officeCode: '01', day: '2026-11-08', paidCents: 100_000, billCount: 1, houseCount: 1 }];
  const base = {
    year: 2026, communities, dailyRows: row, now, granularity: 'month' as const,
    arrears: { totalCents: 0, houseCount: 0, buckets: [] }, recentPayments: [],
  };
  const derived: any = buildScreenSummary({ ...base, targets: [{ id: 1, communityIds: [1], year: 2026, annualCents: 1_200_000, monthCents: Array(12).fill(null) }] });
  assert.equal(derived.monthToDate.targetCents, 100_000);
  assert.equal(derived.monthToDate.targetSource, 'derived');
  assert.equal(derived.monthToDate.rate, 100);
  assert.equal(derived.today.vsMonthRate, 100);
  const explicit: any = buildScreenSummary({ ...base, targets: [{ id: 1, communityIds: [1], year: 2026, annualCents: 1_200_000, monthCents: [...Array(10).fill(null), 250_000, null] }] });
  assert.equal(explicit.monthToDate.targetCents, 250_000);
  assert.equal(explicit.monthToDate.targetSource, 'explicit');
  assert.equal(explicit.monthToDate.rate, 40);
  const mixed: any = buildScreenSummary({
    ...base,
    targets: [
      { id: 1, communityIds: [1], year: 2026, annualCents: 1_200_000, monthCents: [...Array(10).fill(null), 100_000, null] },
      { id: 2, communityIds: [2], year: 2026, annualCents: 600_000, monthCents: Array(12).fill(null) },
    ],
  });
  assert.equal(mixed.monthToDate.targetCents, 150_000);
  assert.equal(mixed.monthToDate.targetSource, 'derived');
  assert.equal(mixed.monthToDate.rate, 66.7);
  const zeroExplicit: any = buildScreenSummary({ ...base, targets: [{ id: 1, communityIds: [1], year: 2026, annualCents: 1_200_000, monthCents: [...Array(10).fill(null), 0, null] }] });
  assert.equal(zeroExplicit.monthToDate.targetCents, 0);
  assert.equal(zeroExplicit.monthToDate.rate, null);
  assert.equal(zeroExplicit.monthToDate.targetSource, 'explicit');
});

test('收费大屏：小区组指标只在组内小区全部选中时命中；部分命中不算，未覆盖进 missing', () => {
  const communities = [
    { id: 1, name: '枫桦景苑一期', offices: ['01'] },
    { id: 2, name: '枫桦景苑二期', offices: ['02'] },
    { id: 16, name: '上海新家', offices: ['04'] },
  ];
  const targets = [{ id: 9, communityIds: [1, 2], year: 2026, annualCents: 1_000_000, monthCents: Array(12).fill(0) }];
  const rows = [
    { officeCode: '01', day: '2026-11-08', paidCents: 100_000, billCount: 1, houseCount: 1 },
    { officeCode: '02', day: '2026-11-08', paidCents: 200_000, billCount: 1, houseCount: 1 },
    { officeCode: '04', day: '2026-11-08', paidCents: 300_000, billCount: 1, houseCount: 1 },
  ];
  const make = (selected: any[]) => buildScreenSummary({ year: 2026, communities: selected, targets, dailyRows: rows, granularity: 'month', now, arrears: { totalCents: 0, houseCount: 0, buckets: [] }, recentPayments: [] }) as any;
  const both: any = make([communities[0], communities[1]]);
  assert.equal(both.target.annualCents, 1_000_000);
  assert.equal(both.target.yearToDateCents, 300_000);
  assert.equal(both.partial, false);
  assert.deepEqual(both.targetScope, { communityIds: [1, 2], communityNames: ['枫桦景苑一期', '枫桦景苑二期'] });
  const all: any = make(communities);
  assert.equal(all.partial, true);
  assert.deepEqual(all.missingTargetCommunities, [{ id: 16, name: '上海新家' }]);
  assert.equal(all.target.yearToDateCents, 300_000);
  const one: any = make([communities[0]]);
  assert.equal(one.target.annualCents, 0);
  assert.equal(one.target.rate, null);
  assert.equal(one.partial, true);
  assert.deepEqual(one.targetScope, { communityIds: [], communityNames: [] });
  assert.deepEqual(one.missingTargetCommunities, [{ id: 1, name: '枫桦景苑一期' }]);
});

test('收费大屏：混合范围只有部分小区有指标时，rate/日均只按有指标小区计算', () => {
  const communities = [
    { id: 1, name: '枫桦景苑一期', offices: ['01'] },
    { id: 2, name: '枫桦景苑二期', offices: ['02'] },
    { id: 16, name: '上海新家', offices: ['04'] },
  ];
  const targets = [{ id: 2, communityIds: [2], year: 2026, annualCents: 398_277_240, monthCents: Array(12).fill(0) }];
  const dailyRows = [
    { officeCode: '01', day: '2026-11-08', paidCents: 100_958_190, billCount: 1, houseCount: 1 },
    { officeCode: '02', day: '2026-11-08', paidCents: 176_862_870, billCount: 80, houseCount: 8 },
    { officeCode: '04', day: '2026-11-08', paidCents: 652_765_700, billCount: 1, houseCount: 1 },
  ];
  const result: any = buildScreenSummary({
    year: 2026, communities, targets, dailyRows, granularity: 'month', now,
    arrears: { totalCents: 0, houseCount: 0, buckets: [] }, recentPayments: [],
  });
  assert.equal(result.target.annualCents, 398_277_240);
  assert.equal(result.target.yearToDateCents, 176_862_870);
  assert.equal(result.target.rate, 44.4);
  assert.equal(result.target.gapCents, 221_414_370);
  assert.equal(result.target.dailyNeedCents, 4_100_266);
  assert.equal(result.partial, true);
  assert.deepEqual(result.targetScope, { communityIds: [2], communityNames: ['枫桦景苑二期'] });
  assert.deepEqual(result.missingTargetCommunities, [{ id: 1, name: '枫桦景苑一期' }, { id: 16, name: '上海新家' }]);
  // 其他指标仍按全部选中小区
  assert.equal(result.today.paidCents, 930_586_760);
  assert.equal(result.communities.find((row: any) => row.communityId === 1).rate, null);
});
