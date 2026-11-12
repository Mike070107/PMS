import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRelease, assertVersionIncrease, evidenceMatches, parkingChanges, feeChanges, productionInput, assistantInput, deploymentCommit, propertyArchiveChanges, parkingSpaceChanges, recoveryRegressionGroups, executeRecoveryGroups } from './release-check.mjs';

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
  assert.equal(feeChanges(['apps/api/src/modules/fees/fees.service.ts']),true);
  assert.equal(feeChanges(['apps/admin-web/src/pages/FeeTemplateSettings.tsx']),true);
  assert.equal(feeChanges(['docs/fees.md']),false);
  assert.equal(parkingChanges(['apps/admin-web/src/pages/ParkingManagementPage.tsx']), true);
  assert.equal(parkingChanges(['apps/api/src/modules/access-card-issuance/dto.ts']), true);
  assert.equal(parkingChanges(['apps/admin-web/src/pages/OtherPage.tsx']), false);
  assert.equal(productionInput('docs/file.md'), false);
  assert.equal(assistantInput('tools/data-sync-assistant-v2/publish-update.ps1'), false);
  assert.equal(assistantInput('tools/data-sync-assistant-v2/SelfTest.cs'), true);
});

test('档案/共享联系人/停车回归按受影响源码选取，助手和无关脏文件不误触发', () => {
  for (const file of ['apps/api/src/modules/owners-mgmt/dto.ts','apps/api/src/modules/properties/properties.service.ts','apps/api/src/entities/house.entity.ts','apps/api/src/modules/access/access.service.ts','apps/neighbor-web/src/pages/PropertyArchive.tsx','apps/neighbor-web/src/components/OwnerBusinessContact.tsx','apps/neighbor-web/src/pages/Cashier.tsx','apps/neighbor-web/src/pages/ApartmentCashier.tsx','apps/neighbor-web/src/pages/Vehicles.tsx','apps/neighbor-web/src/components/parking/RenewSheet.tsx','apps/api/src/migrations/1796000000000-PropertyArchiveDetails.ts']) assert.equal(propertyArchiveChanges([file]),true,file);
  for (const file of ['apps/api/src/entities/parking-space.entity.ts','apps/api/src/modules/business/parking-spaces.service.ts','apps/api/src/modules/business/dto.ts','apps/api/src/migrations/1796100000000-ParkingSpaceCategory.ts','apps/neighbor-web/src/components/parking/ParkingSpaceEditor.tsx','apps/neighbor-web/src/pages/ParkingSpaces.tsx','apps/neighbor-web/src/styles/parking-glass.css']) assert.equal(parkingSpaceChanges([file]),true,file);
  for (const file of ['docs/parking.md','apps/api/src/modules/telemetry/page-meta.ts','apps/neighbor-web/src/pages/Stocktake.tsx']) { assert.equal(propertyArchiveChanges([file]),false); assert.equal(parkingSpaceChanges([file]),false); }
  assert.deepEqual(recoveryRegressionGroups('assistant',['unmarked']),[]);
  assert.deepEqual(recoveryRegressionGroups('api',['apps/api/src/modules/telemetry/page-meta.ts']),[]);
  const archive = recoveryRegressionGroups('api',['apps/api/src/modules/owners-mgmt/dto.ts']);
  assert.deepEqual(archive.map(g=>g.id),['additive-migrations','property-archive']);
  assert.ok(archive.flatMap(g=>g.commands).some(c=>c.includes('property-archive.integration.test.ts')));
  assert.ok(archive.flatMap(g=>g.commands).some(c=>c.includes('property-archive-real-api.test.cjs')));
  const parking = recoveryRegressionGroups('web',['apps/neighbor-web/src/pages/ParkingSpaces.tsx']);
  assert.deepEqual(parking.map(g=>g.id),['additive-migrations','parking-spaces']);
  assert.ok(parking.flatMap(g=>g.commands).some(c=>c.includes('test:parking-spaces')));
  assert.ok(parking.flatMap(g=>g.commands).some(c=>c.includes('parking-space-renewal-browser.test.cjs')));
  assert.deepEqual(recoveryRegressionGroups('web',['unmarked']).map(g=>g.id),['additive-migrations','property-archive','parking-spaces']);
});

test('新门禁先build一次；旧hash不复用、失败不记pass/不继续，同hash全绿才零成本复用', () => {
  const groups=recoveryRegressionGroups('web',['unmarked']), saved={}, executed=[];
  const options={inputHash:'current',load:id=>saved[id],save:(id,data)=>saved[id]=data,execute:command=>executed.push(command)};
  executeRecoveryGroups(groups,options);
  assert.equal(executed.filter(c=>c==='pnpm --filter @pms/neighbor-web build').length,1);
  assert.equal(Object.keys(saved).length,3);
  executed.length=0; executeRecoveryGroups(groups,options); assert.equal(executed.length,0);
  assert.throws(()=>executeRecoveryGroups(groups,{...options,inputHash:'changed',execute:command=>{executed.push(command);if(command.includes('property-archive.integration'))throw Error('real chain failed');}}),/real chain failed/);
  assert.equal(saved['property-archive'].inputHash,'current');
  assert.equal(saved['parking-spaces'].inputHash,'current');
  assert.equal(saved['additive-migrations'].inputHash,'changed');
  assert.ok(!executed.some(c=>c.includes('parking-spaces-browser')));
});

test('无法读取 Git 不是首次部署，权限/进程失败必须停止', () => {
  assert.equal(deploymentCommit('api', () => { throw { status: 1 }; }), null);
  assert.throws(() => deploymentCommit('api', () => { throw new Error('spawn EPERM'); }), /EPERM/);
  assert.equal(deploymentCommit('api', (command) => command === 'show-ref' ? '' : 'known-commit'), 'known-commit');
});
