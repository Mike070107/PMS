import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderStatus } from '../../common/enums';
import { decideAcceptMode, proxyNote } from './work-order-proxy.util';

const S = WorkOrderStatus;

test('被派人本人接单 → accept', () => {
  assert.deepEqual(decideAcceptMode({ status: S.DISPATCHED, assigneeId: 7, userId: 7, canDispatch: false }), { mode: 'accept' });
});

test('派给别人：办公室代接 → accept_on_behalf；维修工 → 拒绝', () => {
  assert.deepEqual(decideAcceptMode({ status: S.DISPATCHED, assigneeId: 7, userId: 1, canDispatch: true }), { mode: 'accept_on_behalf' });
  assert.deepEqual(decideAcceptMode({ status: S.DISPATCHED, assigneeId: 7, userId: 9, canDispatch: false }), { error: '工单已派给其他维修工' });
});

test('待派单 / 等材料 / 未指定负责人 → 认领给自己（办公室也可以）', () => {
  for (const status of [S.CREATED, S.WAITING_MATERIAL]) {
    assert.deepEqual(decideAcceptMode({ status, assigneeId: null, userId: 1, canDispatch: true }), { mode: 'claim' });
    assert.deepEqual(decideAcceptMode({ status, assigneeId: null, userId: 9, canDispatch: false }), { mode: 'claim' });
  }
  assert.deepEqual(decideAcceptMode({ status: S.DISPATCHED, assigneeId: null, userId: 1, canDispatch: true }), { mode: 'claim' });
});

test('代填留痕：操作人≠负责人才加前缀，负责人为空不加', () => {
  assert.equal(proxyNote('换了阀芯', 1, 7), '办公室代填；换了阀芯');
  assert.equal(proxyNote('', 1, 7), '办公室代填');
  assert.equal(proxyNote(' 换了阀芯 ', 7, 7), '换了阀芯');
  assert.equal(proxyNote(null, 1, null), null);
});
