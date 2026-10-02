import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRelease, assertVersionIncrease, evidenceMatches, parkingChanges, productionInput, assistantInput, deploymentCommit } from './release-check.mjs';

test('验收记录必须通过且匹配输入哈希，不能以旧记录放行新源码', () => {
  assert.equal(evidenceMatches({ passed: true, inputHash: 'A' }, 'A'), true);
  for (const evidence of [null, { passed: false, inputHash: 'A' }, { passed: true, inputHash: 'B' }]) assert.equal(evidenceMatches(evidence, 'A'), false);
});
test('线上源码、版本或制品来源不符时失败', () => {
  const expected = { target: 'web', version: '2.0.20261002-1000', commit: 'abc', sourceHash: 'hash' };
  assert.doesNotThrow(() => assertRelease(expected, { ...expected }));
  for (const key of Object.keys(expected)) assert.throws(() => assertRelease(expected, { ...expected, [key]: 'old' }), /不符合/);
  assert.throws(() => assertRelease(expected, undefined));
});
test('助手源码变更必须提高版本，禁止同号覆盖和降级', () => {
  assert.doesNotThrow(() => assertVersionIncrease('2.5.17', '2.5.16'));
  assert.doesNotThrow(() => assertVersionIncrease('2.6.0', '2.5.16'));
  for (const version of ['2.5.16', '2.5.9', 'bad']) assert.throws(() => assertVersionIncrease(version, '2.5.16'));
});
test('按相关路径选择回归；纯文档不制造助手新版本', () => {
  assert.equal(parkingChanges(['apps/admin-web/src/pages/ParkingManagementPage.tsx']), true);
  assert.equal(parkingChanges(['apps/api/src/modules/access-card-issuance/dto.ts']), true);
  assert.equal(parkingChanges(['apps/admin-web/src/pages/OtherPage.tsx']), false);
  assert.equal(productionInput('docs/file.md'), false);
  assert.equal(assistantInput('tools/data-sync-assistant-v2/publish-update.ps1'), false);
  assert.equal(assistantInput('tools/data-sync-assistant-v2/SelfTest.cs'), true);
});

test('无法读取 Git 不是首次部署，权限/进程失败必须停止', () => {
  assert.equal(deploymentCommit('api', () => { throw { status: 1 }; }), null);
  assert.throws(() => deploymentCommit('api', () => { throw new Error('spawn EPERM'); }), /EPERM/);
  assert.equal(deploymentCommit('api', (command) => command === 'show-ref' ? '' : 'known-commit'), 'known-commit');
});
