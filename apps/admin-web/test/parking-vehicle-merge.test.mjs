import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupParkingVehicleRows,
  normalizeParkingDate,
  normalizeParkingRoomIdentity,
  parkingRenewalTargets,
  sameParkingText,
} from '../src/lib/parkingVehicleMerge.ts';

const row = (database, plate, id) => ({ database, plate, id });

test('同车牌在一期、二期各一条时合并为一张卡片', () => {
  const groups = groupParkingVehicleRows([
    row('parking1', '沪 A0A998', '11'),
    row('parking2', '沪a0a998', '22'),
  ], (item) => item.plate, (item) => item.id);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merged, true);
  assert.equal(groups[0].parking1?.id, '11');
  assert.equal(groups[0].parking2?.id, '22');
  assert.deepEqual(parkingRenewalTargets(groups[0]).map((item) => item.id), ['11', '22']);
});

test('同库存在重复车牌时不合并，不隐藏脏数据', () => {
  const groups = groupParkingVehicleRows([
    row('parking1', '沪a0a998', '11'),
    row('parking1', '沪a0a998', '12'),
    row('parking2', '沪a0a998', '22'),
  ], (item) => item.plate, (item) => item.id);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => !group.merged));
  assert.ok(groups.every((group) => parkingRenewalTargets(group).length === 1));
});

test('到期日只比较日期，房号自增后缀仍识别为同一房号', () => {
  assert.equal(normalizeParkingDate('2027-09-30 23:59:59'), '2027-09-30');
  assert.equal(normalizeParkingRoomIdentity('198/5/102/2'), '198/5/102');
  assert.equal(normalizeParkingRoomIdentity('198-5-102'), '198/5/102');
  assert.equal(sameParkingText('地库91号\r\n操作来源：PMS系统', '地库91号\n操作来源：PMS系统'), true);
});
