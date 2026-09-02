import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPublicAreaText,
  detectPublicAreaWord,
  isPublicAreaText,
} from './repair-public-area.util';

/**
 * 漏判和误判的代价不对称，测试按这个来：
 *   漏判 = 公区单挂到某一户，统计脏、上门找错地方；
 *   误判 = 户内单丢掉房号，维修工不知道进哪一户，**当场干不了活**。
 * 所以「拿不准就算户内」，下面那组反例比正例更重要。
 */

test('门口机、单元门、楼道这些明确的公区设施', () => {
  assert.equal(detectPublicAreaWord('5511弄278号503报门口机没有反应'), '门口机');
  assert.ok(isPublicAreaText('单元门推不开'));
  assert.ok(isPublicAreaText('楼道灯不亮'));
  assert.ok(isPublicAreaText('电梯困人了'));
  assert.ok(isPublicAreaText('地下车库的井盖翻了'));
  assert.ok(isPublicAreaText('监控看不到画面'));
  assert.ok(isPublicAreaText('枫桦二期2号802门铃开不了楼下门'));
  assert.equal(classifyPublicAreaText('门铃开不了楼下门'), true);
});

test('户内的一律不算公区', () => {
  assert.ok(!isPublicAreaText('厨房水管漏水'));
  assert.ok(!isPublicAreaText('卫生间马桶堵了'));
  assert.ok(!isPublicAreaText('家里灯不亮'));
  assert.ok(!isPublicAreaText('热水器打不着火'));
  assert.equal(classifyPublicAreaText('家里的门禁对讲没声音'), false);
});

test('说了「我家 / 家里」就按户内，别被句子里的公区词带偏', () => {
  // 「门口」是他家门口，不是单元门口 —— 判成公区就把房号丢了，师傅进不了门
  assert.ok(!isPublicAreaText('我家门口的灯不亮'));
  assert.ok(!isPublicAreaText('家里的门禁对讲没声音'));
});

test('模糊词不认：宁可漏判，也不能把户内单错判成公区', () => {
  assert.equal(detectPublicAreaWord('门口有点吵'), '');
  assert.equal(detectPublicAreaWord('楼上漏水下来了'), '');
  assert.equal(detectPublicAreaWord('水龙头坏了'), '');
  assert.equal(classifyPublicAreaText('门口有点吵'), null);
});
