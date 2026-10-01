import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parkingLegacyRoomFromName,
  parkingPmsHouseKey,
  parkingRoomAddress,
  parseParkingSearch,
  supportsStructuredParkingQueries,
} from './parking-query.util';

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
