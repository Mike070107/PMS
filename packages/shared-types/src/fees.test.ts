/**
 * 公寓收费工作台的地址写法与共用费用清单。
 *
 * 为什么值得一条回归：收费对象原来渲染成「13 130室」，被当成一个号码读
 * （2026-10-11 用户反馈）。楼栋补「号」、楼栋与房号之间必须有「-」这两条规则
 * 现在由 placeLabel 一处实现，网站后台页和员工端小程序页共用；
 * 哪一端自己再拼一遍字符串，小票地址就会和另一端对不上。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { APARTMENT_FEE_TYPES, buildingLabel, placeLabel, roomLabel } from './fees';

test('纯数字楼栋补「号」，已经带了号/栋/幢/座的原样显示', () => {
  assert.equal(buildingLabel('13'), '13号');
  assert.equal(buildingLabel(' 7 '), '7号');
  assert.equal(buildingLabel('A栋34号'), 'A栋34号');
  assert.equal(buildingLabel('3幢'), '3幢');
  assert.equal(buildingLabel(null), '');
});

test('纯数字房号才缀「室」，办公楼的名字房号不缀', () => {
  assert.equal(roomLabel('130'), '130室');
  assert.equal(roomLabel('工程部'), '工程部');
  assert.equal(roomLabel(''), '');
});

test('楼栋和房号之间一定有分隔符，不会连成一个号码', () => {
  assert.equal(placeLabel('13', '130'), '13号-130室');
  assert.equal(placeLabel('A栋34号', '工程部'), 'A栋34号-工程部');
  // 只有一头有值时不留下光秃秃的「-」
  assert.equal(placeLabel('13', ''), '13号');
  assert.equal(placeLabel(null, '130'), '130室');
});

test('两端共用的费用清单：code 不重复，名称和单位都填齐', () => {
  const codes = APARTMENT_FEE_TYPES.map((item) => item.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const item of APARTMENT_FEE_TYPES) {
    assert.ok(item.name, `${item.code} 缺名称`);
    assert.ok(item.unit, `${item.code} 缺单位`);
  }
});
