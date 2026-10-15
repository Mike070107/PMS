import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('历史卡片操作与捷顺最新记录一样分成写库和下发两步', () => {
  const source = readFileSync(new URL('../src/pages/AccessCardIssuancePage.tsx', import.meta.url), 'utf8');
  assert.match(source, /addHistoryCardToAccessDatabase/);
  assert.match(source, /添加至门禁管理系统/);
  assert.match(source, /请先添加至门禁管理系统/);
  assert.match(source, /下发至控制器/);
});
