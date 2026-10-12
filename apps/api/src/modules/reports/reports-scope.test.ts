import assert from 'node:assert/strict';
import test from 'node:test';
import { ReportsService } from './reports.service';

test('人员名单只保留授权管理处员工，不拼入其他管理处或全公司零工单人员', async () => {
  const service = Object.create(ReportsService.prototype) as any;
  service.accessService = {
    officeIdOfCommunity: async (_tenant: number, community: number) => community === 11 ? 1 : 2,
    userOfficeIds: async (_tenant: number, user: number) => ({ all: user === 3, officeIds: user === 1 ? [1] : user === 2 ? [2] : [] }),
  };
  assert.deepEqual(await service.staffIdsInScope(7, [1, 2, 3], [11]), [1]);
  assert.deepEqual(await service.staffIdsInScope(7, [1, 2, 3], [22]), [2]);
  assert.deepEqual(await service.staffIdsInScope(7, [1, 2, 3], []), []);
  assert.deepEqual(await service.staffIdsInScope(7, [1, 2, 3], null), [1, 2, 3]);
});

test('空授权和伪造越权小区直接返回空统计，不读取公司人员名单', async () => {
  const service = Object.create(ReportsService.prototype) as any;
  service.resolveTenantId = () => 7; service.resolveRange = () => ({}); service.rangeView = () => ({});
  service.accessService = { userIdsWithPermission: () => assert.fail('空或越权范围不得读取全公司人员') };
  service.dataSource = { query: () => assert.fail('空或越权范围不得执行统计查询') };
  const empty = await service.staff({}, { id: 1 }, { scopeAll: false, communityIds: [] });
  assert.deepEqual(empty.rows, []); assert.equal(empty.staffCount, 0);
  const forbidden = await service.staff({ communityId: 22 }, { id: 1 }, { scopeAll: false, communityIds: [11] });
  assert.deepEqual(forbidden.rows, []); assert.equal(forbidden.activeNow, 0);
});
