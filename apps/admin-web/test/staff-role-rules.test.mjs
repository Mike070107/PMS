import assert from 'node:assert/strict';
import test from 'node:test';
import { needsReportCommunitySelection } from '../src/lib/staffRoleRules.ts';

test('纯内网应用角色不要求选择可代报小区', () => {
  assert.equal(needsReportCommunitySelection([]), false);
});

test('代住户创建报修时才要求选择小区', () => {
  assert.equal(needsReportCommunitySelection(['app:repair-create']), true);
  assert.equal(
    needsReportCommunitySelection(['app:repair-create', 'app:pool']),
    false,
  );
  assert.equal(
    needsReportCommunitySelection(['app:repair-create', 'app:dispatch']),
    false,
  );
});
