import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPlateCheck,
  daysUntil,
  defaultFamilyGarages,
  familyValidity,
  isExpiringSoon,
  isPastEnd,
  legacyRoomKey,
  normalizeFamilyGarages,
  normalizeFamilyPlate,
  shanghaiDate,
} from './family-car.util';

test('有效期一年：生效日起至次年前一天，闰日按 2 月 28 日到期', () => {
  assert.deepEqual(familyValidity('2026-10-21'), { startDate: '2026-10-21', endDate: '2027-10-20' });
  assert.deepEqual(familyValidity('2026-01-01'), { startDate: '2026-01-01', endDate: '2026-12-31' });
  assert.equal(familyValidity('2028-02-29').endDate, '2029-02-28');
});

test('生效日按上海日期：UTC 16:30 已是上海次日', () => {
  assert.equal(shanghaiDate(new Date('2026-10-20T16:30:00Z')), '2026-10-21');
  assert.equal(shanghaiDate(new Date('2026-10-20T15:59:00Z')), '2026-10-20');
});

test('到期提醒 30 天窗口与过期判断（到期日当天仍有效）', () => {
  assert.equal(daysUntil('2026-11-20', '2026-10-21'), 30);
  assert.equal(isExpiringSoon('2026-11-20', '2026-10-21'), true);
  assert.equal(isExpiringSoon('2026-11-21', '2026-10-21'), false);
  assert.equal(isPastEnd('2026-10-21', '2026-10-21'), false);
  assert.equal(isPastEnd('2026-10-20', '2026-10-21'), true);
});

test('车牌去掉中间的点和空格', () => {
  assert.equal(normalizeFamilyPlate('豫G·q3n07'), '豫GQ3N07');
  assert.equal(normalizeFamilyPlate(' 豫G Q3N07 '), '豫GQ3N07');
});

test('车库按弄默认，非法车库拒绝', () => {
  assert.deepEqual(defaultFamilyGarages('198'), ['phase1']);
  assert.deepEqual(defaultFamilyGarages('228'), ['phase2']);
  assert.throws(() => normalizeFamilyGarages(['phase9']), /不支持/);
  assert.throws(() => normalizeFamilyGarages([]), /至少/);
});

test('旧库房号统一格式', () => {
  assert.equal(legacyRoomKey({ database: 'parking2', fields: { owner_Name: '228/06/0502' } }), '228/6/502');
  assert.equal(legacyRoomKey({ database: 'parking2', fields: { owner_Name: '228弄6号502室' } }), '228/6/502');
  assert.equal(legacyRoomKey({ database: 'parking2', fields: { owner_Name: '' } }), null);
});

test('查重分类：旧库无车牌为新登记', () => {
  assert.deepEqual(classifyPlateCheck([], '豫GQ3N07', '228/6/502'), { mode: 'new' });
  const other = { database: 'parking2', fields: { P_plate: '豫GAAAAA', Car_Brand: '亲情车', owner_Name: '228/6/502' } };
  assert.deepEqual(classifyPlateCheck([other], '豫GQ3N07', '228/6/502'), { mode: 'new' });
});

test('查重分类：本户亲情车为续登，别户或住户车拒绝', () => {
  const own = { database: 'parking2', fields: { P_plate: '豫GQ3N07', Car_Brand: '亲情车', owner_Name: '228/6/502' } };
  assert.deepEqual(classifyPlateCheck([own], '豫G·Q3N07', '228/6/502'), { mode: 'existing', databases: ['parking2'] });
  const resident = { database: 'parking2', fields: { P_plate: '豫GQ3N07', Car_Brand: '住户车', owner_Name: '228/6/502' } };
  const result = classifyPlateCheck([resident], '豫GQ3N07', '228/6/502');
  assert.equal(result.mode, 'conflict');
  const elsewhere = { database: 'parking1', fields: { P_plate: '豫GQ3N07', Car_Brand: '亲情车', owner_Name: '198/1/302' } };
  assert.equal(classifyPlateCheck([elsewhere], '豫GQ3N07', '228/6/502').mode, 'conflict');
});
