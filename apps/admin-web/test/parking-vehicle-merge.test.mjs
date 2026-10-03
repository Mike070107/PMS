import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildParkingRoomOptions,
  groupParkingVehicleRows,
  normalizeParkingDate,
  normalizeManualParkingRoom,
  normalizeParkingRoomIdentity,
  parkingRenewalTargets,
  sameParkingText,
} from '../src/lib/parkingVehicleMerge.ts';

const row = (database, plate, id) => ({ database, plate, id });

test('新增车牌房号直接来自 PMS 房产树，可区分一期二期并搜索姓名', () => {
  const options = buildParkingRoomOptions([
    { id: 1, name: '枫桦景苑一期', parentId: null, isGroup: false, mainLane: '198', buildings: [
      { id: 11, lane: '198', buildingNo: '6', roadName: null, houses: [{ id: 111, roomNo: '501', propertyType: '', shopName: null, ownerId: 9, ownerName: '张三', ownerPhone: '13800000000' }] },
    ] },
    { id: 2, name: '枫桦景苑二期', parentId: null, isGroup: false, mainLane: '228', buildings: [
      { id: 22, lane: '228', buildingNo: '3', roadName: null, houses: [{ id: 222, roomNo: '102', propertyType: '', shopName: null, ownerId: 10, ownerName: '李四', ownerPhone: null }] },
    ] },
  ]);
  assert.deepEqual(options.map(({ roomKey, database }) => ({ roomKey, database })), [
    { roomKey: '198/6/501', database: 'parking1' },
    { roomKey: '228/3/102', database: 'parking2' },
  ]);
  assert.match(options[0].searchText, /6\/501.*张三/);
});

test('新增车牌可手工登记不在 PMS 房产清单里的住户，并准确确定旧库', () => {
  assert.deepEqual(normalizeManualParkingRoom('198弄8号102室'), { database: 'parking1', roomKey: '198/8/102' });
  assert.deepEqual(normalizeManualParkingRoom('228-08-0102'), { database: 'parking2', roomKey: '228/8/102' });
  assert.equal(normalizeManualParkingRoom('8/102'), null);
  assert.equal(normalizeManualParkingRoom('36/502'), null);
  assert.equal(normalizeManualParkingRoom('228/8'), null);

  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /residentMode === 'manual'/, '正式新增车牌窗口必须提供手动登记分支');
  assert.match(page, /pmsUserId: undefined/, '手动登记不应伪造 PMS 用户关联');
  assert.match(page, /ownerAddress: normalizedManualRoom!\.roomKey/, '手动房号必须使用标准化值提交');
});

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
