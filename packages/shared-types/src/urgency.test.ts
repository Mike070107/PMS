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
