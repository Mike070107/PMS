import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderStatus } from '../../common/enums';
import { resolveRollback, type RollbackCandidateLog } from './work-order-state-machine';

/**
 * 撤回要退到哪一步，只能由「上一笔真实业务操作的 before 快照」决定。
 *
 * 这一组用例覆盖的是 2026-09-03 之前会撤错的全部路径：同样是「维修中」，
 * 来路可能是主动认领、等待材料接回、定向派单后接单；同样是「已派单」，
 * 可能是首次派单也可能是换人改派。旧实现按当前状态硬编码退一格，后面几种全是错的。
 */

let nextId = 100;
function log(
  action: string,
  fromStatus: WorkOrderStatus | null,
  toStatus: WorkOrderStatus,
  extra: Partial<RollbackCandidateLog> = {},
): RollbackCandidateLog {
  return {
    id: (nextId += 1),
    action,
    fromStatus,
    toStatus,
    beforeSnapshot: fromStatus ? { status: fromStatus } : null,
    ...extra,
  };
}

/** 日志按 id 倒序传入（最新在前），和 service 里的查询保持一致 */
function newestFirst(...logs: RollbackCandidateLog[]): RollbackCandidateLog[] {
  return [...logs].sort((a, b) => b.id - a.id);
}

test('待派单主动接单后撤回，回到待派单而不是已派单', () => {
  const logs = newestFirst(
    log('create', null, WorkOrderStatus.CREATED),
    log('claim', WorkOrderStatus.CREATED, WorkOrderStatus.IN_PROGRESS),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.IN_PROGRESS, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.CREATED);
  assert.equal(resolution?.log.action, 'claim');
  assert.equal(resolution?.usedSnapshot, true);
});

test('等待材料接回后撤回，回到等待材料', () => {
  const logs = newestFirst(
    log('need_material', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL),
    log('claim', WorkOrderStatus.WAITING_MATERIAL, WorkOrderStatus.IN_PROGRESS),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.IN_PROGRESS, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.WAITING_MATERIAL);
});

test('定向派单接单后撤回，回到已派单', () => {
  const logs = newestFirst(
    log('assign', WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED),
    log('accept', WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.IN_PROGRESS, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.DISPATCHED);
});

test('维修中重新派单后撤回，回到维修中（不是待派单）', () => {
  const logs = newestFirst(
    log('accept', WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS),
    log('assign', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DISPATCHED),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.DISPATCHED, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.IN_PROGRESS);
});

test('已派单换人后撤回，状态不变但要撤销的是这一次改派', () => {
  const logs = newestFirst(
    log('assign', WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED),
    log('assign', WorkOrderStatus.DISPATCHED, WorkOrderStatus.DISPATCHED, {
      beforeSnapshot: { status: WorkOrderStatus.DISPATCHED },
    }),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.DISPATCHED, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.DISPATCHED);
  // 撤的必须是最新那条改派，不能一路撤到首次派单
  assert.equal(resolution?.log.id, Math.max(...logs.map((item) => item.id)));
});

test('转单后撤回，从待派单恢复到维修中', () => {
  const logs = newestFirst(
    log('accept', WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS),
    log('transfer_request', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.CREATED),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.CREATED, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.IN_PROGRESS);
  assert.equal(resolution?.log.action, 'transfer_request');
});

test('真正首次创建的待派单不能撤回', () => {
  const logs = newestFirst(log('create', null, WorkOrderStatus.CREATED));
  const { resolution, blockedReason } = resolveRollback(WorkOrderStatus.CREATED, logs);
  assert.equal(resolution, undefined);
  assert.match(blockedReason ?? '', /最早的待派单/);
});

test('已撤单撤回，恢复撤单前的真实状态', () => {
  const logs = newestFirst(
    log('need_material', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL),
    log('cancel', WorkOrderStatus.WAITING_MATERIAL, WorkOrderStatus.CANCELLED),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.CANCELLED, logs);
  assert.equal(resolution?.targetStatus, WorkOrderStatus.WAITING_MATERIAL);
});

test('已完成撤回只撤验收，目标是待验收', () => {
  const logs = newestFirst(
    log('complete', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DONE_PENDING_REVIEW),
    log('review', WorkOrderStatus.DONE_PENDING_REVIEW, WorkOrderStatus.COMPLETED),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.COMPLETED, logs);
  assert.equal(resolution?.log.action, 'review');
  assert.equal(resolution?.targetStatus, WorkOrderStatus.DONE_PENDING_REVIEW);
});

test('待验收继续撤回，撤的是完工，回到等待材料', () => {
  const logs = newestFirst(
    log('claim', WorkOrderStatus.CREATED, WorkOrderStatus.WAITING_MATERIAL),
    log('complete', WorkOrderStatus.WAITING_MATERIAL, WorkOrderStatus.DONE_PENDING_REVIEW),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.DONE_PENDING_REVIEW, logs);
  assert.equal(resolution?.log.action, 'complete');
  assert.equal(resolution?.targetStatus, WorkOrderStatus.WAITING_MATERIAL);
});

test('已经撤回过的一步不会被再撤一次，连续撤回自然往前走', () => {
  const reviewLog = log('review', WorkOrderStatus.DONE_PENDING_REVIEW, WorkOrderStatus.COMPLETED, {
    revertedByLogId: 999,
  });
  const logs = newestFirst(
    log('complete', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DONE_PENDING_REVIEW),
    reviewLog,
    { ...log('rollback', WorkOrderStatus.COMPLETED, WorkOrderStatus.DONE_PENDING_REVIEW), id: 999 },
  );
  const { resolution } = resolveRollback(WorkOrderStatus.DONE_PENDING_REVIEW, logs);
  assert.equal(resolution?.log.action, 'complete');
  assert.equal(resolution?.targetStatus, WorkOrderStatus.IN_PROGRESS);
});

test('维修进度、催单这类不改流程的动作不算「上一步」', () => {
  const logs = newestFirst(
    log('claim', WorkOrderStatus.CREATED, WorkOrderStatus.IN_PROGRESS),
    log('progress', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.IN_PROGRESS),
    log('urge_office', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.IN_PROGRESS),
  );
  const { resolution } = resolveRollback(WorkOrderStatus.IN_PROGRESS, logs);
  assert.equal(resolution?.log.action, 'claim');
  assert.equal(resolution?.targetStatus, WorkOrderStatus.CREATED);
});

test('老日志没有快照时：完工可按兼容规则撤，转单/改派拒绝并提示人工处理', () => {
  const legacyComplete = newestFirst({
    ...log('complete', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DONE_PENDING_REVIEW),
    beforeSnapshot: null,
  });
  const okResult = resolveRollback(WorkOrderStatus.DONE_PENDING_REVIEW, legacyComplete);
  assert.equal(okResult.resolution?.targetStatus, WorkOrderStatus.IN_PROGRESS);
  assert.equal(okResult.resolution?.usedSnapshot, false);

  const legacyTransfer = newestFirst({
    ...log('transfer_request', WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.CREATED),
    beforeSnapshot: null,
  });
  const blocked = resolveRollback(WorkOrderStatus.CREATED, legacyTransfer);
  assert.equal(blocked.resolution, undefined);
  assert.match(blocked.blockedReason ?? '', /原维修工|人工/);
});
