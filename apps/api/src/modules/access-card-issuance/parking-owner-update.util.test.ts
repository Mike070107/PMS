import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeParkingOwnerFieldHints,
  normalizeParkingOwnerValues,
  parkingOwnerChanges,
  parkingOwnerJoinedFieldValue,
  supportsParkingOwnerUpdates,
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

test('网页提示的列名必须去掉 Owner 前缀', () => {
  assert.deepEqual(normalizeParkingOwnerFieldHints({ name: 'Owner__Owner_Name', phone: 'Owner__P_Tel' }), {
    name: 'Owner_Name', phone: 'P_Tel',
  });
});
