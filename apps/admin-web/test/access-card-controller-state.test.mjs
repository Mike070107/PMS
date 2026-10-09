import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRetryHistoricalControllerUpload } from '../src/pages/access-card-controller-state.ts';

test('门禁库已读到权限时不再显示陈旧的重试下发', () => {
  assert.equal(shouldRetryHistoricalControllerUpload('controller_uploaded', 'failed'), false);
});

test('权限表仍未读到且最近任务失败时保留重试入口', () => {
  assert.equal(shouldRetryHistoricalControllerUpload('not_uploaded', 'failed'), true);
  assert.equal(shouldRetryHistoricalControllerUpload('permission_check_pending', 'failed'), true);
  assert.equal(shouldRetryHistoricalControllerUpload('not_uploaded', 'completed'), false);
});
