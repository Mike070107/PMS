import assert from 'node:assert/strict';
import test from 'node:test';
import { compareNameAlphabetically, compareWorkOrderPriority } from './list-order';

test('工单紧急优先，同一天把相邻地址排在一起', () => {
  const rows = [
    { id: 4, urgent: false, createdAt: '2026-09-01T08:00:00Z', summaryAddress: '枫桦二期25号303室' },
    { id: 3, urgent: true, createdAt: '2026-09-02T08:00:00Z', summaryAddress: '枫桦二期8号' },
    { id: 2, urgent: false, createdAt: '2026-09-01T07:00:00Z', summaryAddress: '枫桦二期2号201室' },
    { id: 1, urgent: false, createdAt: '2026-09-01T06:00:00Z', summaryAddress: '枫桦二期25号302室' },
  ];
  rows.sort(compareWorkOrderPriority);
  assert.deepEqual(rows.map((row) => row.id), [3, 2, 1, 4]);
});

test('已超时和两小时内到期的工单排在就近优化之前', () => {
  const now = new Date('2026-09-03T08:00:00Z').getTime();
  const rows = [
    { id: 1, createdAt: '2026-09-03T01:00:00Z', slaDueAt: '2026-09-04T08:00:00Z', summaryAddress: '枫桦二期2号' },
    { id: 2, createdAt: '2026-09-03T02:00:00Z', slaDueAt: '2026-09-03T09:00:00Z', summaryAddress: '远处小区99号' },
    { id: 3, createdAt: '2026-09-03T03:00:00Z', slaDueAt: '2026-09-03T07:00:00Z', summaryAddress: '远处小区100号' },
  ];
  rows.sort((a, b) => compareWorkOrderPriority(a, b, now));
  assert.deepEqual(rows.map((row) => row.id), [3, 2, 1]);
});

test('材料名称按拼音 A-Z，并按数字自然排序', () => {
  const names = ['照明灯', '材料10', '扳手', '安全帽', '材料2'];
  names.sort(compareNameAlphabetically);
  assert.deepEqual(names, ['安全帽', '扳手', '材料2', '材料10', '照明灯']);
});
