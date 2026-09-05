import assert from 'node:assert/strict';
import test from 'node:test';
import { PurchaseRequestStatus } from '../../common/enums';
import { nextPurchaseStatus, nextStepLabel, purchaseSteps } from './purchase-flow';

const full = { office: 'summary' as const, manager: true, purchaser: true, skipManagerBelowYuan: 0, skipPurchaserBelowYuan: 0 };

test('默认链：办公室汇总 → 经理 → 采购 → 通过，和原来一样', () => {
  assert.equal(nextPurchaseStatus(full, 'create', 0), PurchaseRequestStatus.OFFICE_REVIEW);
  assert.equal(nextPurchaseStatus(full, 'office', 0), PurchaseRequestStatus.MANAGER_REVIEW);
  assert.equal(nextPurchaseStatus(full, 'manager', 0), PurchaseRequestStatus.PURCHASER_REVIEW);
  assert.equal(nextPurchaseStatus(full, 'purchaser', 0), PurchaseRequestStatus.APPROVED);
});

test('关掉的环节直接越过：办公室关了缺料直接进经理；经理关了办公室提交直接到采购；都关了直接通过', () => {
  assert.equal(nextPurchaseStatus({ ...full, office: 'off' }, 'create', 0), PurchaseRequestStatus.MANAGER_REVIEW);
  assert.equal(nextPurchaseStatus({ ...full, manager: false }, 'office', 0), PurchaseRequestStatus.PURCHASER_REVIEW);
  assert.equal(nextPurchaseStatus({ ...full, manager: false, purchaser: false }, 'office', 0), PurchaseRequestStatus.APPROVED);
  assert.equal(nextPurchaseStatus({ office: 'off', manager: false, purchaser: false, skipManagerBelowYuan: 0, skipPurchaserBelowYuan: 0 }, 'create', 0), PurchaseRequestStatus.APPROVED);
});

test('金额阈值：低于阈值跳过那一环，等于或高于不跳；阈值 0 = 不跳', () => {
  const s = { ...full, skipManagerBelowYuan: 500, skipPurchaserBelowYuan: 100 };
  assert.equal(nextPurchaseStatus(s, 'office', 49_999), PurchaseRequestStatus.PURCHASER_REVIEW, '499.99 元跳过经理、采购部照批');
  assert.equal(nextPurchaseStatus(s, 'office', 50_000), PurchaseRequestStatus.MANAGER_REVIEW, '500 元不跳');
  assert.equal(nextPurchaseStatus(s, 'office', 3_000), PurchaseRequestStatus.APPROVED, '30 元两环都跳，直接通过');
  assert.equal(nextStepLabel(s, 'office', 3_000), '直接通过，待下单');
  assert.equal(nextStepLabel(full, 'office', 0), '物业经理审批');
});

test('审批链视图：跳过的环节标 skipped 并说明原因，当前环节标 current', () => {
  const steps = purchaseSteps(
    { ...full, office: 'approve', manager: false },
    { status: PurchaseRequestStatus.PURCHASER_REVIEW, estTotalCents: 12_000, officeReviewedAt: '2026-09-05T01:00:00Z' },
    { office: '王办' },
  );
  assert.deepEqual(steps.map((s) => [s.key, s.state]), [
    ['office', 'done'], ['manager', 'skipped'], ['purchaser', 'current'], ['order', 'pending'],
  ]);
  assert.equal(steps[0].label, '办公室审批');
  assert.equal(steps[0].by, '王办');
  assert.equal(steps[1].note, '未启用');
});
