import assert from 'node:assert/strict';
import test from 'node:test';
import { PurchaseRequestStatus } from '../../common/enums';
import { planPurchaseRollback, type PurchaseRollbackRequestLike } from './rollback-purchase';

/**
 * 撤回缺料时采购申请的三档处理（2026-09-06 Mike 定）。
 * 以前只要申请进了经理审批或被合并就整单拦住，办公室拆不开合并表，等于永远撤不了。
 */

const WO = 19;

function request(
  status: PurchaseRequestStatus,
  items: PurchaseRollbackRequestLike['items'],
  extra: Partial<PurchaseRollbackRequestLike> = {},
): PurchaseRollbackRequestLike {
  return { id: 7, requestNo: 'PR-7', status, workOrderId: WO, items, ...extra };
}

test('只有本工单材料的申请：办公室汇总阶段整单驳回，不打扰审批人', () => {
  const [d] = planPurchaseRollback(WO, [
    request(PurchaseRequestStatus.OFFICE_REVIEW, [{ lineId: '7-1' }, { lineId: '7-2' }]),
  ]);
  assert.equal(d.effect, 'reject');
  assert.equal(d.notifyStage, false);
  assert.match(d.note, /整单驳回/);
});

test('只有本工单材料、已到经理审批：整单驳回并提醒经理', () => {
  const [d] = planPurchaseRollback(WO, [request(PurchaseRequestStatus.MANAGER_REVIEW, [{ lineId: '7-1' }])]);
  assert.equal(d.effect, 'reject');
  assert.equal(d.notifyStage, true);
  assert.match(d.note, /物业经理会收到提醒/);
});

test('合并表里还有别的工单的行：只划掉本工单的行，其余不动', () => {
  const [d] = planPurchaseRollback(WO, [
    request(
      PurchaseRequestStatus.PURCHASER_REVIEW,
      [
        { lineId: 'a', sourceWorkOrderId: WO },
        { lineId: 'b', sourceWorkOrderId: 20 },
        { lineId: 'c', sourceWorkOrderId: WO },
        // 已被单项驳回的不再算
        { lineId: 'd', sourceWorkOrderId: WO, rejectReason: '重复' },
      ],
      { workOrderId: 20 },
    ),
  ]);
  assert.equal(d.effect, 'strip');
  assert.deepEqual(d.lineIds, ['a', 'c']);
  assert.match(d.note, /2 行将划掉，其余 1 行不受影响；采购部会收到提醒/);
});

test('行上没写来源工单时按申请单本身的工单算；老数据没 lineId 按位置补', () => {
  const [d] = planPurchaseRollback(WO, [
    request(PurchaseRequestStatus.OFFICE_REVIEW, [{}, { sourceWorkOrderId: 21 }]),
  ]);
  assert.equal(d.effect, 'strip');
  assert.deepEqual(d.lineIds, ['7-1']);
});

test('本工单的行都已被驳回：不用动', () => {
  const [d] = planPurchaseRollback(WO, [
    request(PurchaseRequestStatus.MANAGER_REVIEW, [{ lineId: '7-1', rejectReason: '不买了' }, { lineId: 'x', sourceWorkOrderId: 3 }]),
  ]);
  assert.equal(d.effect, 'none');
});

test('已批准待下单：采购不动，提醒采购部；已转采购单：不动也不提醒', () => {
  const [approved, done] = planPurchaseRollback(WO, [
    request(PurchaseRequestStatus.APPROVED, [{ lineId: '7-1' }]),
    { ...request(PurchaseRequestStatus.DONE, [{ lineId: '8-1' }]), id: 8, requestNo: 'PR-8' },
  ]);
  assert.equal(approved.effect, 'keep');
  assert.equal(approved.notifyStage, true);
  assert.equal(done.effect, 'keep');
  assert.equal(done.notifyStage, false);
  assert.match(done.note, /到货后照常入库/);
});

test('已驳回 / 已合并进别的申请：不用动', () => {
  const [rejected, merged] = planPurchaseRollback(WO, [
    request(PurchaseRequestStatus.REJECTED, [{ lineId: '7-1' }]),
    { ...request(PurchaseRequestStatus.MERGED, [{ lineId: '9-1' }]), id: 9, requestNo: 'PR-9' },
  ]);
  assert.equal(rejected.effect, 'none');
  assert.equal(merged.effect, 'none');
  assert.match(merged.note, /按合并后的那张处理/);
});
