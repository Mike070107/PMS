import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUrgency } from './urgency';

/**
 * 紧急判定错一次的代价是两头的：漏标 = 真急的单排在后面；
 * 乱标 = 满屏红标，派单的人不再当真。这里锁住的是会真说出口的句子。
 */

test('说了「急修」就是紧急', () => {
  const r = detectUrgency('一期17号201水管爆了，要急修');
  assert.equal(r.urgent, true);
  assert.equal(r.matched, '急修');
});

test('同义说法：紧急 / 加急 / 抢修', () => {
  assert.equal(detectUrgency('紧急，楼道灯全灭了').urgent, true);
  assert.equal(detectUrgency('这单加急处理').urgent, true);
  assert.equal(detectUrgency('污水外冒，需要抢修').urgent, true);
});

test('没说加急的普通报修不标', () => {
  assert.equal(detectUrgency('一期17号201家里灯不亮').urgent, false);
  assert.equal(detectUrgency('').urgent, false);
  assert.equal(detectUrgency(null).urgent, false);
});

test('否定：「不用急修」「不算紧急」不标', () => {
  assert.equal(detectUrgency('滴两滴水而已，不用急修').urgent, false);
  assert.equal(detectUrgency('不急修，师傅方便时来一趟就行').urgent, false);
  assert.equal(detectUrgency('这个不算紧急').urgent, false);
  assert.equal(detectUrgency('没那么紧急').urgent, false);
});

test('零件名里的「紧急」不是在催', () => {
  // 电梯轿厢里那个按钮就叫「紧急呼叫按钮」，说它坏了不等于这单要加急
  assert.equal(detectUrgency('电梯紧急呼叫按钮按了没反应').urgent, false);
  assert.equal(detectUrgency('地下车库紧急照明不亮').urgent, false);
});

test('一句话里既有零件名又真的在催，仍然算紧急', () => {
  const r = detectUrgency('电梯紧急呼叫按钮坏了，急修');
  assert.equal(r.urgent, true);
  assert.equal(r.matched, '急修');
});

// ---- 2026-08-31 用户提的三类：急急急 / 单个急 / 有人出不来 ----

test('连着喊的「急急」「急急急」：整串当命中词', () => {
  assert.deepEqual(detectUrgency('一期17号201水管爆了，急急急'), {
    urgent: true,
    matched: '急急急',
  });
  assert.equal(detectUrgency('大门打不开了急急').matched, '急急');
});

test('单个「急」也是在催', () => {
  assert.equal(detectUrgency('楼道灯全灭了，急').urgent, true);
  assert.equal(detectUrgency('业主很急，等着用水').urgent, true);
  assert.equal(detectUrgency('急死了，赶紧来人').urgent, true);
});

test('「急」在这些词里不是催：应急照明 / 急救 / 急停按钮', () => {
  assert.equal(detectUrgency('地下车库应急照明不亮').urgent, false);
  assert.equal(detectUrgency('急救箱里的东西空了，要补').urgent, false);
  assert.equal(detectUrgency('电梯急停按钮被按了').urgent, false);
  // 「紧急」有自己的零件名过滤，单字「急」不能从旁边绕过去
  assert.equal(detectUrgency('电梯紧急呼叫按钮按了没反应').urgent, false);
});

test('单个「急」也吃否定：不急 / 别急 / 没那么急', () => {
  assert.equal(detectUrgency('这个不急，师傅顺路来看看就行').urgent, false);
  assert.equal(detectUrgency('别急，明天来也行').urgent, false);
  assert.equal(detectUrgency('没那么急').urgent, false);
});

test('有人被关在里面：一个急字都没有，但最急', () => {
  assert.equal(detectUrgency('电子门坏了，居民出不来').urgent, true);
  assert.equal(detectUrgency('电梯困人').urgent, true);
  assert.equal(detectUrgency('有人在里面出不来').urgent, true);
  assert.equal(detectUrgency('老太太被困在电梯里').urgent, true);
});

test('「出不来」不挨着人就不算 —— 热水出不来是最常见的报修话', () => {
  assert.equal(detectUrgency('热水器坏了，热水出不来').urgent, false);
  assert.equal(detectUrgency('厨房水龙头水出不来').urgent, false);
});

test('「打不开」里的不是补语不是否定：大门打不开了急修，仍然是紧急', () => {
  assert.equal(detectUrgency('大门打不开了急修').urgent, true);
  assert.equal(detectUrgency('大门关不上急急').urgent, true);
  // 真否定还是要拦住
  assert.equal(detectUrgency('大门关不上，不用急修').urgent, false);
});
