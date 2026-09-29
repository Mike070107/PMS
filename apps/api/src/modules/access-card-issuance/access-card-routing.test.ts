import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessSystemOf,
  icToWg,
  legacyRoomKey,
  legacyDatabaseRoomKey,
  nextLegacyUserSequence,
  projectPhaseOf,
} from './access-card-routing';

test('识别枫桦景苑期数并按二期楼栋选择门禁系统', () => {
  assert.equal(projectPhaseOf('枫桦景苑一期'), 'phase1');
  assert.equal(projectPhaseOf('枫桦景苑二期'), 'phase2');
  assert.equal(accessSystemOf('phase1', '5'), null);
  assert.equal(accessSystemOf('phase2', '5'), 'mjsystem');
  assert.equal(accessSystemOf('phase2', '04'), 'iccard');
  assert.equal(accessSystemOf('phase2', '99'), null);
});

test('房号展示不强制给楼栋补零', () => {
  assert.equal(legacyRoomKey('228', '05', '301'), '228/5/301');
  assert.equal(legacyRoomKey(null, '5', '301'), '5/301');
  assert.equal(legacyDatabaseRoomKey('228', '5', '301'), '228/05/301');
});

test('IC 转 WG 与旧 PHP 字节顺序一致', () => {
  assert.equal(icToWg('112233'), '05108721');
  assert.throws(() => icToWg('XYZ'));
});

test('旧库按基础房号统计，并为同房新用户分配累计序号', () => {
  assert.deepEqual(
    nextLegacyUserSequence('228/5/301', [
      '228/5/301/1',
      '228/5/301/2',
      '228/5/301/5',
      '228/5/30/6',
      '228/5/301/作废',
    ]),
    { issuedCount: 3, nextSequence: 6 },
  );
});
