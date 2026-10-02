import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeParkingOwnerFieldHints,
  normalizeParkingOwnerValues,
  parkingLegacyOwnerValuesFromFields,
  parkingOwnerChanges,
  parkingOwnerJoinedFieldValue,
  supportsParkingOwnerUpdates,
  applyParkingOwnerSnapshot,
  parkingOwnerWriteMismatches,
  supportsParkingAuthorizationFixes,
  supportsParkingVehicleSync,
} from './parking-owner-update.util';

test('住户更新值只去首尾空格并保留原始姓名间距和备注换行', () => {
  assert.deepEqual(normalizeParkingOwnerValues({
    name: '  张  三 ', phone: ' 138 0000 0000 ', room: ' 228/02/102 ', note: ' 地库91号 \r\n 业主车 ',
  }), {
    name: '张  三', phone: '138 0000 0000', room: '228/02/102', note: '地库91号\n业主车',
  });
});

test('住户联查优先使用 Owner 字段，不把车辆备注和电话当成住户资料', () => {
  const fields = { P_Tel: '021-vehicle', P_note: '车辆备注', Owner__P_Tel: '13800000000', Owner__P_note: '住户备注' };
  assert.equal(parkingOwnerJoinedFieldValue(fields, ['phone', 'tel', 'ptel']), '13800000000');
  assert.equal(parkingOwnerJoinedFieldValue(fields, ['remark', 'note', 'pnote']), '住户备注');
});

test('P_Owner.owner_Name 固定解释为房号且旧库姓名为空', () => {
  assert.deepEqual(parkingLegacyOwnerValuesFromFields({
    Owner__UserID: 414,
    Owner__owner_Name: '228-31-702',
    Owner__owner_Tel: '13402178801',
    P_note: '俞李文',
  }), {
    name: null,
    phone: '13402178801',
    room: '228-31-702',
  });
});

test('只记录真正改动的住户字段', () => {
  const before = normalizeParkingOwnerValues({ name: '张三', phone: '1', room: '101', note: null });
  const after = normalizeParkingOwnerValues({ name: '张三', phone: '2', room: '101', note: '操作来源：PMS系统' });
  assert.deepEqual(parkingOwnerChanges(before, after).map((item) => item.field), ['phone', 'note']);
});

test('只有新版助手可领取住户更新任务', () => {
  assert.equal(supportsParkingOwnerUpdates('2.2.2'), false);
  assert.equal(supportsParkingOwnerUpdates('2.3.0'), true);
  assert.equal(supportsParkingOwnerUpdates('0.6.2'), false);
  assert.equal(supportsParkingOwnerUpdates('0.7.0'), true);
});

test('跨库车辆资料对齐只交给 2.5.19 及以上助手', () => {
  assert.equal(supportsParkingVehicleSync('2.5.17'), false);
  assert.equal(supportsParkingVehicleSync('2.5.18'), false);
  assert.equal(supportsParkingVehicleSync('2.5.19'), true);
  assert.equal(supportsParkingVehicleSync('2.6.0'), true);
  assert.equal(supportsParkingVehicleSync('3.0.0'), true);
  assert.equal(supportsParkingVehicleSync('0.9.0'), false);
});

test('车库授权、车辆类型和下载下发只交给 2.5.21 及以上助手', () => {
  assert.equal(supportsParkingAuthorizationFixes('2.5.20'), false);
  assert.equal(supportsParkingAuthorizationFixes('2.5.21'), true);
  assert.equal(supportsParkingAuthorizationFixes('2.6.0'), true);
  assert.equal(supportsParkingAuthorizationFixes('3.0.0'), true);
  assert.equal(supportsParkingAuthorizationFixes('0.9.0'), false);
});

test('网页提示的列名必须去掉 Owner 前缀', () => {
  assert.deepEqual(normalizeParkingOwnerFieldHints({ name: 'Owner__Owner_Name', phone: 'Owner__P_Tel' }), {
    name: 'Owner_Name', phone: 'P_Tel',
  });
});

test('联查住户值为空时不能借用车辆或其他同名字段', () => {
  assert.equal(parkingOwnerJoinedFieldValue({ Owner__owner_Tel: null, P_Tel: '错误号码' }, ['ownertel', 'ptel']), null);
});

test('同住户两辆车只共享电话房号，不共享车辆备注', () => {
  const before = { plate: '苏K163SM', ownerId: '1851', ownerName: null, phone: null, room: '228/53/301', note: 'A' };
  const result = { name: null, phone: '02112345678', room: '228/53/302', note: 'B\n操作来源：PMS系统' };
  assert.equal(applyParkingOwnerSnapshot(before, result, '苏K163SM').note, result.note);
  const sibling = applyParkingOwnerSnapshot({ ...before, plate: '沪A007U0' }, result, '苏K163SM');
  assert.equal(sibling.note, 'A');
  assert.equal(sibling.phone, result.phone);
  assert.equal(sibling.room, result.room);
  assert.equal('name' in sibling, false);
});

test('成功回报必须逐项等于请求值，备注允许补来源标记并统一换行', () => {
  const request = { name: null, phone: '02112345678', room: '228/53/301', note: '第一行\n第二行' };
  const result = { ...request, note: '第一行\r\n第二行\r\n操作来源：PMS系统' };
  assert.deepEqual(parkingOwnerWriteMismatches(request, result), []);
  assert.deepEqual(parkingOwnerWriteMismatches(request, { ...result, phone: null }), ['电话']);
  assert.deepEqual(parkingOwnerWriteMismatches(request, { ...result, note: '其他备注' }), ['备注']);
  assert.deepEqual(parkingOwnerWriteMismatches({ ...request, note: null }, { ...result, note: '操作来源：PMS系统' }), []);
});
