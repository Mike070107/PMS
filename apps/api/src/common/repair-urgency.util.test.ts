import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUrgency } from './repair-urgency.util';

/**
 * 服务端这份判定和 shared-types 那份是同源复制，用例也保持一致 ——
 * 两边判得不一样，就会出现「小程序上显示紧急、提交后单子不是紧急」。
 */

test('说了「急修」就是紧急', () => {
  assert.deepEqual(detectUrgency('一期17号201水管爆了，要急修'), { urgent: true, matched: '急修' });
});

test('同义说法：紧急 / 加急 / 抢修', () => {
  assert.equal(detectUrgency('紧急，楼道灯全灭了').urgent, true);
  assert.equal(detectUrgency('这单加急处理').urgent, true);
  assert.equal(detectUrgency('污水外冒，需要抢修').urgent, true);
});

test('普通报修不标', () => {
  assert.equal(detectUrgency('一期17号201家里灯不亮').urgent, false);
  assert.equal(detectUrgency('').urgent, false);
  assert.equal(detectUrgency(undefined).urgent, false);
});

test('否定不标', () => {
  assert.equal(detectUrgency('滴两滴水而已，不用急修').urgent, false);
  assert.equal(detectUrgency('这个不算紧急').urgent, false);
});

test('零件名不标', () => {
  assert.equal(detectUrgency('电梯紧急呼叫按钮按了没反应').urgent, false);
  assert.equal(detectUrgency('地下车库紧急照明不亮').urgent, false);
});
