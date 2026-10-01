import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFreshParkingPlateCheck,
  exactParkingPlateMatches,
  parkingLegacyRoomFromName,
  parkingPlateFromFields,
  parkingPmsHouseKey,
  parkingRoomAddress,
  parseParkingSearch,
  supportsStructuredParkingQueries,
} from './parking-query.util';

const duplicateRows = [{ database: 'parking2', fields: { P_plate: '沪EDK889', Owner__Room_No: '228/5/301' } }];

test('两段房号保留楼栋边界，不把 6 号楼扩成 36 号楼', () => {
  assert.deepEqual(parseParkingSearch('6/502'), { kind: 'house', term: '6/502' });
  assert.deepEqual(parseParkingSearch('06-502'), { kind: 'house', term: '06/502' });
});

test('完整房号兼容弄号文字和旧库卡序号后缀', () => {
  assert.deepEqual(parseParkingSearch('198弄6号402室'), { kind: 'house', term: '198/6/402' });
  assert.deepEqual(parseParkingSearch('228/02/102/5'), { kind: 'house', term: '228/02/102/5' });
});

test('区分完整车牌、车牌尾号、电话和姓名', () => {
  assert.equal(parseParkingSearch('沪BDQ8839').kind, 'plate');
  assert.deepEqual(parseParkingSearch('DQ8839'), { kind: 'plate_tail', term: 'DQ8839' });
  assert.deepEqual(parseParkingSearch('8839'), { kind: 'plate_tail', term: '8839' });
  assert.deepEqual(parseParkingSearch('13800001234'), { kind: 'phone', term: '13800001234' });
  assert.deepEqual(parseParkingSearch('张三'), { kind: 'resident', term: '张三' });
});

test('拒绝会造成大范围扫描的短数字', () => {
  assert.throws(() => parseParkingSearch('502'), /数字信息太少/);
  assert.throws(() => parseParkingSearch('12'), /数字信息太少/);
});

test('只有带结构化查询边界的现场助手才能领取查询', () => {
  assert.equal(supportsStructuredParkingQueries('2.3.0'), false);
  assert.equal(supportsStructuredParkingQueries('2.4.0'), true);
  assert.equal(supportsStructuredParkingQueries('0.7.0'), false);
  assert.equal(supportsStructuredParkingQueries('0.8.0'), true);
});

test('人员姓名栏中的旧库标准地址按房号解释', () => {
  assert.equal(parkingLegacyRoomFromName('198-6-402'), '198/6/402');
  assert.equal(parkingLegacyRoomFromName('已隐藏228/02/102/5'), '228/2/102');
  assert.equal(parkingLegacyRoomFromName('张三'), null);
});

test('停车旧库的多种房号格式统一匹配同一套 PMS 房产', () => {
  const expected = '198/6/402';
  for (const value of ['198/6/402', '198/06/402', '198-6-402', '198-06-402', '198弄6号402室']) {
    assert.equal(parkingRoomAddress(value)?.key, expected);
  }
  assert.equal(parkingPmsHouseKey('198', '06', '0402'), expected);
});

test('新增车牌查重按旧库车牌字段做精确匹配', () => {
  assert.equal(parkingPlateFromFields({ P_plate: ' 沪E·DK889 ' }), '沪EDK889');
  assert.equal(exactParkingPlateMatches(duplicateRows, '沪EDK889').length, 1);
  assert.equal(exactParkingPlateMatches(duplicateRows, '沪EDK88').length, 0);
});

test('已存在车牌不能通过新增车牌查重', () => {
  assert.throws(() => assertFreshParkingPlateCheck({
    term: '沪EDK889', status: 'completed', rows: duplicateRows, completedAt: '2026-10-01T10:00:00.000Z',
  }, '沪EDK889', new Date('2026-10-01T10:01:00.000Z')), /已存在于枫桦景苑二期停车系统/);
});

test('新增车牌提交只接受当前车牌五分钟内完成的真实查重', () => {
  const clearQuery = { term: '沪A12345', status: 'completed', rows: [], completedAt: '2026-10-01T10:00:00.000Z' };
  assert.doesNotThrow(() => assertFreshParkingPlateCheck(clearQuery, '沪A12345', new Date('2026-10-01T10:04:59.000Z')));
  assert.throws(() => assertFreshParkingPlateCheck(clearQuery, '沪B12345', new Date('2026-10-01T10:01:00.000Z')), /当前车牌不一致/);
  assert.throws(() => assertFreshParkingPlateCheck(clearQuery, '沪A12345', new Date('2026-10-01T10:05:01.000Z')), /超过 5 分钟/);
});
