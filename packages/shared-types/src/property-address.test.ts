import assert from 'node:assert/strict';
import test from 'node:test';
import { composePropertyRoom, splitOfficeRoom } from './property-address';
import { buildingMatchKeys, communityMatchKeys, formatAddressLine, formatBuildingFull, formatBuildingLabel, formatFullAddress, houseMatchKeys, scoreAddressPath, tokenizeAddress } from './address';

test('总公司单栋办公楼：楼层与部门组成位置，不伪造楼号或室号', () => {
  const room = composePropertyRoom({ propertyType: '办公楼', floorNo: 3, roomNo: ' 财务部 ' });
  const building = { buildingNo: '', lane: null, roadName: null };
  assert.equal(room, '3楼财务部');
  assert.equal(formatAddressLine({ name: '吴泾物业总公司' }, building, room), '吴泾物业总公司3楼财务部');
  assert.equal(formatBuildingLabel({ mainLane: null }, building), '本栋（无楼号）');
  assert.equal(formatBuildingFull(building), '');
  assert.equal(formatFullAddress('吴泾物业总公司', building, room), '吴泾物业总公司/3楼财务部');
  assert.deepEqual(splitOfficeRoom(room), { floorNo: 3, roomNo: '财务部' });
  const levels = [
    communityMatchKeys({ id: 18, name: '吴泾物业总公司', mainLane: null, parentId: null, isGroup: false, buildings: [] }),
    buildingMatchKeys({ id: 100, ...building, houses: [] }),
    houseMatchKeys({ id: 1000, roomNo: room, propertyType: '办公楼', shopName: null }),
  ];
  assert.ok(scoreAddressPath(tokenizeAddress('吴泾物业总公司/3楼财务部'), levels) > 0);
  assert.ok(scoreAddressPath(tokenizeAddress('3楼财务部'), levels) > 0);
});

test('公寓仍用真实楼栋和房号，不被楼层字段影响', () => {
  const room = composePropertyRoom({ propertyType: '公寓', floorNo: 3, roomNo: '101' });
  assert.equal(room, '101');
  assert.equal(formatAddressLine({ name: '馨香公寓吴泾店' }, { buildingNo: '1', lane: null, roadName: null }, room), '馨香公寓吴泾店1号101室');
});

test('办公楼数字房间保留室后缀，旧的无楼层部门编辑不丢失', () => {
  assert.equal(composePropertyRoom({ propertyType: '办公楼', floorNo: 3, roomNo: '301' }), '3楼301室');
  assert.deepEqual(splitOfficeRoom('3楼301室'), { floorNo: 3, roomNo: '301' });
  assert.deepEqual(splitOfficeRoom('工程部'), { roomNo: '工程部' });
  assert.equal(composePropertyRoom({ propertyType: '办公楼', roomNo: '工程部' }), '工程部');
  assert.equal(composePropertyRoom({ propertyType: '办公楼', floorNo: 3, roomNo: '' }), '');
});
