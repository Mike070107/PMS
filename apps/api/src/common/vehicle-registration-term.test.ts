import assert from 'node:assert/strict';
import test from 'node:test';
import { isRegistrationDate, normalizeRegistrationTerm, registrationWindow } from './vehicle-registration-term';

test('严格校验登记月份、自然日期和自定义原因，不隐式转换或滚动日期', () => {
  assert.deepEqual(normalizeRegistrationTerm(undefined), { mode: 'months', months: 12 });
  for (const months of [0, 61, -1, 1.5, '1', true, NaN, Infinity])
    assert.throws(() => normalizeRegistrationTerm({ mode: 'months', months }));
  for (const date of ['2026-02-29', '2026-04-31', '2026-00-01', '2026-01-00', '2026-1-1', '2026-01-01T00:00:00Z', '', 20260101])
    assert.equal(isRegistrationDate(date), false, String(date));
  assert.equal(isRegistrationDate('2028-02-29'), true);
  assert.throws(() => normalizeRegistrationTerm({ mode: 'dates', startDate: '2026-01-02', endDate: '2026-01-01', reason: 'x' }));
  assert.throws(() => normalizeRegistrationTerm({ mode: 'dates', startDate: '2026-01-01', endDate: '2026-01-02', reason: ' ' }));
  assert.throws(() => normalizeRegistrationTerm({ mode: 'dates', startDate: '2026-01-01', endDate: '2026-01-02', months: 12, reason: 'x' }));
  assert.throws(() => normalizeRegistrationTerm({ mode: 'months', months: 1, startDate: '2026-01-01' }));
});

test('登记共用钳制自然月再减一天：月末、闰年和跨年', () => {
  for (const [start, months, end] of [
    ['2026-01-31', 1, '2026-02-27'], ['2028-01-31', 1, '2028-02-28'],
    ['2028-02-29', 12, '2029-02-27'], ['2026-11-19', 1, '2026-12-18'],
    ['2026-12-31', 2, '2027-02-27'], ['2026-01-01', 60, '2030-12-31'],
  ] as const) {
    assert.deepEqual(registrationWindow(normalizeRegistrationTerm({ mode: 'months', months }), start), { startDate: start, endDate: end });
  }
});

test('自定义日期保持审批快照，不随实际执行日平移', () => {
  const term = normalizeRegistrationTerm({ mode: 'dates', startDate: '2026-11-21', endDate: '2026-12-15', reason: '  临时安排  ' });
  assert.deepEqual(registrationWindow(term, '2026-11-22'), { startDate: '2026-11-21', endDate: '2026-12-15' });
});
