import assert from 'node:assert/strict';
import test from 'node:test';
import { sortTimelineNewestFirst } from './timeline';

test('时间线按实际时刻倒序，兼容时区偏移，不按ISO字符串字典序', () => {
  const rows = [{ at: '2026-11-16T09:00:00+08:00' }, { at: '2026-11-16T02:00:00Z' }];
  assert.deepEqual(sortTimelineNewestFirst(rows, r => r.at), [rows[1], rows[0]]);
});
test('冻结输入不mutation，相同时间默认稳定保持原序', () => {
  const rows = Object.freeze([Object.freeze({ at: '2026-11-16T01:00:00Z', key: 'a' }), Object.freeze({ at: '2026-11-16T01:00:00Z', key: 'b' })]);
  const sorted = sortTimelineNewestFirst(rows, r => r.at);
  assert.notEqual(sorted, rows);
  assert.deepEqual(sorted, rows);
});
test('日志同一时刻有流水号时用流水号倒序，流水号相同仍稳定', () => {
  const rows = [{ at: '2026-11-16T01:00:00Z', id: 1 }, { at: '2026-11-16T01:00:00Z', id: 2 }, { at: '2026-11-16T01:00:00Z', id: 2 }];
  assert.deepEqual(sortTimelineNewestFirst(rows, r => r.at, r => r.id), [rows[1], rows[2], rows[0]]);
});
test('空/缺失/非法时刻放尾部且保持原序，不伪造最新事件', () => {
  const rows = [{ at: '' }, { at: 'bad' }, { at: '2026-11-16T01:00:00Z' }, { at: null }];
  assert.deepEqual(sortTimelineNewestFirst(rows, r => r.at), [rows[2], rows[0], rows[1], rows[3]]);
});
test('空集合和缺失字段安全返回，不依赖输入顺序', () => {
  assert.deepEqual(sortTimelineNewestFirst(null, (r: { at: string }) => r.at), []);
  assert.deepEqual(sortTimelineNewestFirst(undefined, (r: { at: string }) => r.at), []);
  assert.deepEqual(sortTimelineNewestFirst([], (r: { at: string }) => r.at), []);
});
test('支持数值和Date，毫秒零点不是缺失值', () => {
  const rows = [{ at: 0 }, { at: new Date(10) }, { at: -10 }];
  assert.deepEqual(sortTimelineNewestFirst(rows, r => r.at), [rows[1], rows[0], rows[2]]);
});
