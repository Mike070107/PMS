import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderStatus } from './enums';
import {
  canEditRepairTypeAndSla,
  canEditWorkOrderAddress,
  repairTypeAndSlaLockReason,
  workOrderAddressLockReason,
} from './work-order-stage';

/**
 * 什么阶段能改什么。**地址和类型的口径故意不一样**（2026-09-15 Mike 要的改地址）：
 * - 类型/截止日期：开工就锁 —— 维修工已经按类型领了料、按截止排了班；
 * - 地址：开工之后也能改 —— 地址认错往往是维修工到了现场才发现的，
 *   这时候不给改就只能作废重报，之前的进度、用料、照片全白做；完工之后才锁。
 */

test('类型/截止：只有待派单、已派单能改', () => {
  assert.equal(canEditRepairTypeAndSla(WorkOrderStatus.CREATED), true);
  assert.equal(canEditRepairTypeAndSla(WorkOrderStatus.DISPATCHED), true);
  assert.equal(canEditRepairTypeAndSla(WorkOrderStatus.IN_PROGRESS), false);
  assert.equal(repairTypeAndSlaLockReason(WorkOrderStatus.IN_PROGRESS), '已开始维修，不能再修改');
});

test('地址：维修中、等材料也能改', () => {
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.CREATED), true);
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.DISPATCHED), true);
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.IN_PROGRESS), true);
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.WAITING_MATERIAL), true);
  assert.equal(workOrderAddressLockReason(WorkOrderStatus.IN_PROGRESS), null);
});

test('地址：完工/撤单/作废之后不给改，且要说清为什么', () => {
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.DONE_PENDING_REVIEW), false);
  assert.match(
    workOrderAddressLockReason(WorkOrderStatus.DONE_PENDING_REVIEW) || '',
    /已完工/,
  );
  assert.equal(canEditWorkOrderAddress(WorkOrderStatus.COMPLETED), false);
  assert.match(workOrderAddressLockReason(WorkOrderStatus.CANCELLED) || '', /已撤单/);
  assert.match(workOrderAddressLockReason(WorkOrderStatus.VOIDED) || '', /已作废/);
});
