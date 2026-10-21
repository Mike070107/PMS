import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldRetryHistoricalControllerUpload, controllerBuildingResults } from '../src/pages/access-card-controller-state.ts';

for (const [operation, status] of [['controller_upload', 'controller_uploaded'], ['controller_revoke', 'controller_removed']]) {
  test(`${operation} 逐栋显示成功、离线和未回报，不能把全部门栋标为失败`, () => {
    const rows = controllerBuildingResults({ operation, status: 'failed',
      targetBuildings: [{ buildingNo: '26' }, { buildingNo: '20' }, { buildingNo: '9' }],
      controllerResults: [{ buildingNo: '26', status }, { buildingNo: '20', status: 'controller_failed', error: '控制器离线' }],
    });
    assert.deepEqual(rows.map((row) => row.succeeded), [true, false, false]);
    assert.equal(rows[1].detail, '控制器离线');
    assert.equal(rows[2].detail, '未完成，请重试');
  });
}

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
