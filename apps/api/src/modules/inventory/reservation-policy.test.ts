import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReservationCapacity } from './reservation-policy';

test('库存预留以其他工单已锁定数量为基准，不能超额占用', () => {
  assert.doesNotThrow(() => assertReservationCapacity(5, 3, 2));
  assert.throws(() => assertReservationCapacity(5, 3, 3), /库存不足/);
  assert.throws(() => assertReservationCapacity(5, 0, -1), /数量/);
});
