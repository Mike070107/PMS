import assert from 'node:assert/strict';
import test from 'node:test';
import { compareWorkOrderRoutePriority } from './work-order-sort';

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
