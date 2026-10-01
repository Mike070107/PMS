import assert from 'node:assert/strict';
import test from 'node:test';
import { diffParkingSnapshot, type ParkingSnapshotValues } from './parking-history.util';

const original: ParkingSnapshotValues = {
  plate: '沪A12345', ownerId: '18', ownerName: '张三', phone: '13800000000', room: '228/5/301', note: null,
};

test('首次观察只建立基线，不伪造历史事件', () => {
  assert.deepEqual(diffParkingSnapshot(null, original), []);
});

test('同一旧库车辆记录换牌时保留换牌前后值', () => {
  const events = diffParkingSnapshot(original, { ...original, plate: '沪B67890', plateChangedAt: '2026-09-29T15:42:00+08:00' });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'plate_change');
  assert.deepEqual(events[0].changes[0], { field: 'plate', label: '车牌', before: '沪A12345', after: '沪B67890' });
  assert.equal(events[0].occurredAt, '2026-09-29T15:42:00+08:00');
});

test('绑定用户变更与普通电话修改分成不同事件', () => {
  const rebound = diffParkingSnapshot(original, { ...original, ownerId: '29', ownerName: '李四', phone: '13900000000' });
  assert.equal(rebound[0].eventType, 'owner_rebind');
  assert.deepEqual(rebound[0].changes.map((item) => item.label), ['绑定用户编号', '姓名', '电话']);

  const phone = diffParkingSnapshot(original, { ...original, phone: '13700000000' });
  assert.equal(phone[0].eventType, 'owner_info_update');
  assert.deepEqual(phone[0].changes[0], { field: 'phone', label: '电话', before: '13800000000', after: '13700000000' });
});
