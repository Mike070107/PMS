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
  legacyRoomOfRow,
  parseLegacyRoomText,
  roomKey,
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

test('旧库房号：序号括号、换车牌、已隐藏、备注后缀、两段按库补弄号', () => {
  const k = (s: string, db = 'parking1') => { const r = parseLegacyRoomText(s, db); return r && r.kind === 'house' ? `${r.lane}/${r.buildingNo}/${r.roomNo}` : r ? `${r.road}/${r.number}` : null; };
  assert.equal(k('198-46-101(2)'), '198/46/101');
  assert.equal(k('198-46-101 (1)'), '198/46/101');
  assert.equal(k('198-24-501（1）'), '198/24/501');
  assert.equal(k('198/14/102换车牌'), '198/14/102');
  assert.equal(k('已隐藏198-6-402/2'), '198/6/402');
  assert.equal(k('228-2-901租', 'parking2'), '228/2/901');
  assert.equal(k('198-27-602新业主'), '198/27/602');
  assert.equal(k('14/102'), '198/14/102');
  assert.equal(k('20/501新车', 'parking2'), '228/20/501');
  assert.equal(k('228弄06号0402室', 'parking2'), '228/6/402');
});

test('旧库商铺：路名 + 门牌', () => {
  assert.deepEqual(parseLegacyRoomText('永德路169号商铺'), { kind: 'shop', road: '永德路', number: '169', source: '永德路169号商铺' });
  assert.equal((parseLegacyRoomText('永德路187') as any).number, '187');
  assert.equal((parseLegacyRoomText('永德路187二楼美容院') as any).number, '187');
  assert.equal((parseLegacyRoomText('宝秀路701号') as any).road, '宝秀路');
});

test('认不出的不猜：备注、错位数字', () => {
  for (const s of ['建行', '悠闲居装饰', '居委小高', '1968-2-201', '2228-47-502', '']) assert.equal(parseLegacyRoomText(s, 'parking1'), null, s);
});

test('owner_Name 是人名时，房号在 owner_Add，人名是车主', () => {
  const row = { database: 'parking1', fields: { Owner__owner_Name: '陈程', Owner__owner_Add: '198/11/102' } };
  const r = legacyRoomOfRow(row);
  assert.equal(r.personName, '陈程');
  assert.equal(legacyRoomKey(row), '198/11/102');
  assert.equal(legacyRoomKey({ database: 'parking1', fields: { Owner__owner_Name: '198-46-101(2)' } }), '198/46/101');
  assert.equal(legacyRoomKey({ database: 'parking1', fields: { Owner__owner_Name: '永德路169号商铺' } }), '永德路169号商铺');
});

test('商铺写回旧库用旧库写法', () => {
  assert.equal(roomKey('永德路', '169', '商铺'), '永德路169号商铺');
  assert.equal(roomKey('198', '06', '0402'), '198/6/402');
});
