import assert from 'node:assert/strict';
import test from 'node:test';
import { findSmartRepairWarehouse, hasSmartRepairSkill } from './warehouse-preference';
import { AccessService } from '../modules/access/access.service';

test('只有 smart 工种按智能化维修工处理', () => {
  assert.equal(hasSmartRepairSkill(['water', 'smart']), true);
  assert.equal(hasSmartRepairSkill(['water', 'electric']), false);
});

test('智能化维修工仓库优先精确名称，并忽略停用仓', () => {
  const picked = findSmartRepairWarehouse([
    { id: 1, name: '枫桦管理处仓', enabled: true },
    { id: 2, name: '某某智能化维修仓', enabled: true },
    { id: 3, name: '智能化维修工仓库', enabled: true },
  ]);
  assert.equal(picked?.id, 3);
  assert.equal(
    findSmartRepairWarehouse([{ id: 4, name: '智能化维修工仓库', enabled: false }]),
    null,
  );
});

test('智能化工种的专属仓自动并入角色额外仓库权限', async () => {
  const service = Object.create(AccessService.prototype) as any;
  service.userRoleRepo = { find: async () => [] };
  service.roleWarehouseRepo = { find: async () => [] };
  service.smartWarehouseIdOfUser = async () => 88;
  assert.deepEqual(await service.extraWarehouseIdsOfUser(1, 9), [88]);
});
