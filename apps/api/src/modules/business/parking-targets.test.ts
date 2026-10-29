import assert from 'node:assert/strict';
import test from 'node:test';
import { findParkingTarget, PARKING_TARGETS, targetsForCommunity, validateRuleTarget } from './parking-targets';

test('目录：key 唯一，德立云目标都有停车场名，本地目标都有库与授权目标', () => {
  assert.equal(new Set(PARKING_TARGETS.map((t) => t.key)).size, PARKING_TARGETS.length);
  for (const t of PARKING_TARGETS) {
    if (t.system === 'deliyun') assert.ok(t.deliyunPark && t.key === `deliyun:${t.deliyunPark}`);
    else assert.ok(t.database && t.localTarget && t.key === `local:${t.localTarget}`);
    assert.ok(t.communities.length > 0);
  }
});

test('枫桦景苑一期、二期都能办四个车库：一期地面、二期地面、二期大车库（本地库）、二期人防（德立云）', () => {
  const all = ['local:phase1_parking', 'local:phase2_parking', 'local:phase2_main_garage', 'deliyun:枫桦景苑'];
  assert.deepEqual(targetsForCommunity('枫桦景苑二期').map((t) => t.key), all);
  assert.deepEqual(targetsForCommunity('枫桦景苑一期').map((t) => t.key), all);
  assert.deepEqual(targetsForCommunity('枫桦景苑一期').map((t) => t.short), ['一期地面', '二期地面', '二期大车库', '二期人防车库']);
});

test('永南三个弄都走德立云「上海永南小区」；马桥店与公寓不出现', () => {
  for (const c of ['永南140弄', '永南150弄', '永南5511弄']) assert.equal(targetsForCommunity(c)[0]?.deliyunPark, '上海永南小区');
  assert.deepEqual(targetsForCommunity('馨香臣寓马桥店'), []);
  assert.deepEqual(targetsForCommunity('馨香臣寓颛桥店'), []);
  assert.deepEqual(targetsForCommunity(null), []);
});

test('规则校验：未绑定放行；乱写、跨小区、无小区都拒绝', () => {
  assert.equal(validateRuleTarget({ targetKey: undefined, communityName: null }), null);
  assert.equal(validateRuleTarget({ targetKey: 'deliyun:上海永南小区', communityName: '永南150弄' }), null);
  assert.match(validateRuleTarget({ targetKey: 'deliyun:不存在', communityName: '永南150弄' })!, /不认识/);
  assert.match(validateRuleTarget({ targetKey: 'deliyun:上海永南小区', communityName: '吴泾一村' })!, /不适用/);
  assert.match(validateRuleTarget({ targetKey: 'local:phase1_parking', communityName: null })!, /必须指定小区/);
  assert.equal(findParkingTarget(123), null);
});
