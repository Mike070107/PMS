import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_LIST_LIMIT,
  compareWorkOrderNewestFirst,
  compareWorkOrderOldestFirst,
  compareWorkOrderRoutePriority,
} from './work-order-sort';

test('现场工单同日按地址聚拢，但不越过紧急和超时优先级', () => {
  const now = new Date('2026-09-03T08:00:00Z').getTime();
  const rows = [
    { id: 1, createdAt: '2026-09-03T01:00:00Z', summaryAddress: '枫桦二期25号303室' },
    { id: 2, createdAt: '2026-09-03T02:00:00Z', summaryAddress: '枫桦二期2号201室' },
    { id: 3, createdAt: '2026-09-03T03:00:00Z', summaryAddress: '枫桦二期25号302室' },
    { id: 4, urgent: true, createdAt: '2026-09-03T04:00:00Z', summaryAddress: '远处小区' },
    { id: 5, createdAt: '2026-09-03T05:00:00Z', slaDueAt: '2026-09-03T07:00:00Z', summaryAddress: '远处小区' },
  ];
  rows.sort((a, b) => compareWorkOrderRoutePriority(a, b, now));
  assert.deepEqual(rows.map((row) => row.id), [4, 5, 2, 3, 1]);
});

test('工单池 / 在手工单：紧急先，其余按报修时间从早到晚，越老越靠前（2026-09-06 Mike）', () => {
  const rows = [
    { id: 1, createdAt: '2026-09-05T01:00:00Z' },
    { id: 2, createdAt: '2026-09-03T02:00:00Z' },
    { id: 3, urgent: true, createdAt: '2026-09-06T03:00:00Z' },
    { id: 4, createdAt: '2026-09-04T04:00:00Z', slaDueAt: '2026-09-04T05:00:00Z' },
    { id: 5, createdAt: '2026-09-03T02:00:00Z' },
  ];
  rows.sort(compareWorkOrderOldestFirst);
  // 超时的 4 号不再插队：老单本来就在前面，单看时间就够了
  assert.deepEqual(rows.map((row) => row.id), [3, 2, 5, 4, 1]);
});

test('我报的 / 已完结：最近的在上面；最多只展示 30 条', () => {
  const rows = [
    { id: 1, createdAt: '2026-09-03T01:00:00Z' },
    { id: 2, createdAt: '2026-09-06T02:00:00Z' },
    { id: 3, createdAt: '2026-09-04T03:00:00Z' },
    { id: 4, createdAt: null },
  ];
  rows.sort(compareWorkOrderNewestFirst);
  assert.deepEqual(rows.map((row) => row.id), [2, 3, 1, 4]);
  assert.equal(RECENT_LIST_LIMIT, 30);
});
