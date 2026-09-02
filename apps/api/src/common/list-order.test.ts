import assert from 'node:assert/strict';
import test from 'node:test';
import { compareNameAlphabetically, compareWorkOrderPriority } from './list-order';

test('工单按紧急分组，组内按报修时间从早到晚', () => {
  const rows = [
    { id: 4, urgent: false, createdAt: '2026-09-01T08:00:00Z' },
    { id: 3, urgent: true, createdAt: '2026-09-02T08:00:00Z' },
    { id: 2, urgent: false, createdAt: '2026-08-31T08:00:00Z' },
    { id: 1, urgent: true, createdAt: '2026-08-30T08:00:00Z' },
  ];
  rows.sort(compareWorkOrderPriority);
  assert.deepEqual(rows.map((row) => row.id), [1, 3, 2, 4]);
});

test('材料名称按拼音 A-Z，并按数字自然排序', () => {
  const names = ['照明灯', '材料10', '扳手', '安全帽', '材料2'];
  names.sort(compareNameAlphabetically);
  assert.deepEqual(names, ['安全帽', '扳手', '材料2', '材料10', '照明灯']);
});
