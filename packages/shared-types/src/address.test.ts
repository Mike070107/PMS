import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAddressLine, isLaneRedundant } from './address';

/**
 * 地址少一段还是多一段，代价都落在维修工腿上：
 * 多一段是「永北5511弄 5511弄278号」这种读着别扭；
 * 少一段是「198弄17号」和「228弄17号」显示成同一个地址，按门牌找过去白跑一趟。
 * 所以这里把「什么时候能省弄号」钉死。
 */

const b = (lane: string | null, no: string, road: string | null = null) => ({
  lane,
  buildingNo: no,
  roadName: road,
});

test('小区名里已经写了这个弄 → 省掉，不说两遍', () => {
  const c = { name: '永南140弄', mainLane: '140', laneCount: 1 };
  assert.equal(isLaneRedundant(c, '140'), true);
  assert.equal(formatAddressLine(c, b('140', '3'), '201'), '永南140弄3号201室');
});

test('小区就这一个弄 → 说了小区名就等于说了弄号', () => {
  const c = { name: '枫桦景苑一期', mainLane: '198', laneCount: 1 };
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期17号201室');
});

test('小区有好几个弄 → 一个都不能省，否则两个地址长得一模一样', () => {
  const c = { name: '枫桦景苑一期', mainLane: '198', laneCount: 3 };
  assert.equal(isLaneRedundant(c, '198'), false);
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期198弄17号201室');
  assert.equal(formatAddressLine(c, b('228', '17'), '201'), '枫桦景苑一期228弄17号201室');
});

test('弄数未知时保守保留弄号：宁可多一段，也不能把两个地址显示成一个', () => {
  const c = { name: '枫桦景苑一期', mainLane: '198' };
  assert.equal(formatAddressLine(c, b('198', '17'), '201'), '枫桦景苑一期198弄17号201室');
});

test('没有弄号的按路名走', () => {
  const c = { name: '锦川公寓', mainLane: null, laneCount: 0 };
  assert.equal(formatAddressLine(c, b(null, '153', '永德路'), '502'), '锦川公寓永德路153号502室');
});

test('只到楼栋 / 只到小区也要拼得出来', () => {
  const c = { name: '吴泾新村', mainLane: '5530', laneCount: 1 };
  assert.equal(formatAddressLine(c, b('5530', '12')), '吴泾新村12号');
  assert.equal(formatAddressLine(c), '吴泾新村');
});
