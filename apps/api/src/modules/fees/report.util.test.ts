import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketStart,
  dayStart,
  daysBetween,
  fillTrendBuckets,
  foldToBuckets,
  formatDay,
  growthRate,
  nextDayStart,
  previousRange,
  shareRatio,
  shiftDay,
  todayRange,
} from './report.util';

// 下面的断言都用绝对时刻（toISOString）比对，不依赖跑测试的机器时区：
// 开发机是 UTC+8，生产服务器是 UTC，两边必须算出同一个结果。

test('自然日边界按上海时区取，不随机器时区漂移', () => {
  assert.equal(dayStart('2026-10-10').toISOString(), '2026-10-09T16:00:00.000Z');
  assert.equal(nextDayStart('2026-10-10').toISOString(), '2026-10-10T16:00:00.000Z');
  // 跨月跨年
  assert.equal(nextDayStart('2026-10-31').toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(nextDayStart('2026-12-31').toISOString(), '2026-12-31T16:00:00.000Z');
});

test('北京时间凌晨收的款算当天，不算前一天', () => {
  // UTC 2026-10-09 17:30 = 北京 2026-10-10 01:30
  const earlyMorning = new Date('2026-10-09T17:30:00Z');
  assert.equal(formatDay(earlyMorning), '2026-10-10');
  const range = todayRange(earlyMorning);
  assert.equal(range.day, '2026-10-10');
  assert.ok(range.from <= earlyMorning && earlyMorning < range.to);

  // 北京 2026-10-10 23:59 仍在当天
  const lateNight = new Date('2026-10-10T15:59:00Z');
  assert.equal(formatDay(lateNight), '2026-10-10');
  const lateRange = todayRange(lateNight);
  assert.equal(lateRange.day, '2026-10-10');
  assert.ok(lateNight < lateRange.to);
});

test('日期加减跨月跨年不出错', () => {
  assert.equal(shiftDay('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('环比区间是等长往前平移，不是上个自然月', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-10'), 10);
  assert.deepEqual(previousRange('2026-10-01', '2026-10-10'), {
    from: '2026-09-21',
    to: '2026-09-30',
  });
  assert.deepEqual(previousRange('2026-10-10', '2026-10-10'), {
    from: '2026-10-09',
    to: '2026-10-09',
  });
});

test('上期为 0 时不编造环比百分比', () => {
  assert.equal(growthRate(150000, 100000), 50);
  assert.equal(growthRate(100000, 150000), -33.3);
  assert.equal(growthRate(100000, 0), null);
  assert.equal(growthRate(0, 0), null);
});

test('趋势桶按周一起算，和 date_trunc(week) 一致', () => {
  assert.equal(bucketStart('2026-10-10', 'day'), '2026-10-10');
  assert.equal(bucketStart('2026-10-10', 'month'), '2026-10-01');
  // 2026-10-10 是周六，所属周起点是 2026-10-05（周一）
  assert.equal(bucketStart('2026-10-10', 'week'), '2026-10-05');
  // 2026-10-11 是周日，仍属于 10-05 那一周
  assert.equal(bucketStart('2026-10-11', 'week'), '2026-10-05');
  assert.equal(bucketStart('2026-10-12', 'week'), '2026-10-12');
});

test('没收款的日期补成 0，趋势图不会把两天连成直线', () => {
  const rows = [
    { bucket: '2026-10-01', amountCents: 150000, count: 1 },
    { bucket: '2026-10-03', amountCents: 20000, count: 2 },
  ];
  assert.deepEqual(fillTrendBuckets(rows, '2026-10-01', '2026-10-04', 'day'), [
    { bucket: '2026-10-01', amountCents: 150000, count: 1 },
    { bucket: '2026-10-02', amountCents: 0, count: 0 },
    { bucket: '2026-10-03', amountCents: 20000, count: 2 },
    { bucket: '2026-10-04', amountCents: 0, count: 0 },
  ]);
});

test('按月分桶时首尾月都在，中间空月补 0', () => {
  const rows = [{ bucket: '2026-12-01', amountCents: 500, count: 1 }];
  assert.deepEqual(
    fillTrendBuckets(rows, '2026-11-15', '2027-01-20', 'month').map((b) => b.bucket),
    ['2026-11-01', '2026-12-01', '2027-01-01'],
  );
  assert.equal(fillTrendBuckets(rows, '2026-11-15', '2027-01-20', 'month')[1].amountCents, 500);
});

test('按天查出来的流水能折进周桶，跨周不会并到一起', () => {
  const days = [
    // 10-05 ~ 10-11 是同一周（周一起算）
    { day: '2026-10-09', amountCents: 150000, count: 1 },
    { day: '2026-10-11', amountCents: 8600, count: 2 },
    // 下一周
    { day: '2026-10-12', amountCents: 1000, count: 1 },
  ];
  assert.deepEqual(foldToBuckets(days, '2026-10-09', '2026-10-12', 'week'), [
    { bucket: '2026-10-05', amountCents: 158600, count: 3 },
    { bucket: '2026-10-12', amountCents: 1000, count: 1 },
  ]);
});

test('折月桶时红冲的负数能把当月收款抵掉', () => {
  const days = [
    { day: '2026-10-10', amountCents: 150000, count: 1 },
    { day: '2026-10-20', amountCents: -150000, count: 1 },
  ];
  assert.deepEqual(foldToBuckets(days, '2026-10-01', '2026-10-31', 'month'), [
    { bucket: '2026-10-01', amountCents: 0, count: 2 },
  ]);
});

test('合计为 0 时不编造占比', () => {
  assert.equal(shareRatio(150000, 158600), 94.6);
  assert.equal(shareRatio(0, 158600), 0);
  assert.equal(shareRatio(100, 0), null);
});
