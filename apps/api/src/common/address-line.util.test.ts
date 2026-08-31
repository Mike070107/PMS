import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAddressLine, isLaneRedundant } from './address-line.util';

/**
 * 和 packages/shared-types/src/address.test.ts 是同一批用例 —— 那份是两个小程序和后台用的，
 * 这份是服务端用的。两边必须给出一模一样的结果，否则卡片上的地址和通知里的地址对不上。
 */

const b = (lane: string | null, no: string, road: string | null = null) => ({
  lane,
  buildingNo: no,
  roadName: road,
});

test('小区名里已经写了这个弄 → 省掉，不说两遍', () => {
  const c = { name: '永南140弄', laneCount: 1 };
  assert.equal(isLaneRedundant(c, '140'), true);
  assert.equal(formatAddressLine(c, b('140', '3'), '201'), '永南140弄3号201室');
});

test('小区就这一个弄 → 说了小区名就等于说了弄号', () => {
  const c = { name: '枫桦景苑一期', laneCount: 1 };
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期17号201室');
});

test('小区有好几个弄 → 一个都不能省，否则两个地址长得一模一样', () => {
  const c = { name: '枫桦景苑一期', laneCount: 3 };
  assert.equal(isLaneRedundant(c, '198'), false);
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期198弄17号201室');
  assert.equal(formatAddressLine(c, b('228', '17'), '201'), '枫桦景苑一期228弄17号201室');
});

test('弄数不确定时保守保留：宁可多一段，也不能把两个地址显示成一个', () => {
  const c = { name: '枫桦景苑一期' };
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期198弄17号201室');
});

test('没有弄号的按路名走', () => {
  const c = { name: '锦川公寓', laneCount: 0 };
  assert.equal(formatAddressLine(c, b(null, '153', '永德路'), '502'), '锦川公寓永德路153号502室');
});

test('只到楼栋 / 只到小区也要拼得出来', () => {
  const c = { name: '吴泾新村', laneCount: 1 };
  assert.equal(formatAddressLine(c, b('5530', '12')), '吴泾新村12号');
  assert.equal(formatAddressLine(c), '吴泾新村');
});
