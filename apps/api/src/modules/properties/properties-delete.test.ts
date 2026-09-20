import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { Building, Community, CommunitySpot, QrCode, Unit } from '../../entities';
import { PropertiesService } from './properties.service';

function fixture(options: { houses?: number; workOrders?: Array<{ id: number; orderNo: string }> } = {}) {
  const service = Object.create(PropertiesService.prototype) as any;
  const deleted: string[] = [];
  let transactions = 0;
  const buildings = [{ id: 562 }, { id: 563 }, { id: 564 }];
  const manager = {
    count: async () => 0,
    delete: async (target: { name?: string }, _where: unknown) => {
      deleted.push(target.name || String(target));
    },
    transaction: async (run: (tx: typeof manager) => Promise<void>) => {
      transactions += 1;
      await run(manager);
    },
  };
  service.communityRepo = {
    manager,
    findOne: async () => ({ id: 18, tenantId: 1, name: '吴泾物业总公司' }),
    count: async () => 0,
  };
  service.buildingRepo = { find: async () => buildings };
  service.houseRepo = { count: async () => options.houses ?? 0 };
  const orders = options.workOrders ?? [];
  service.workOrderRepo = {
    count: async () => orders.length,
    find: async () => orders,
  };
  const user = { id: 7, tenantId: 1, role: UserRole.STAFF } as any;
  return { service, user, deleted, get transactions() { return transactions; } };
}

test('小区无房产、无历史业务时，同一事务清理空楼栋及从属档案', async () => {
  const f = fixture();
  const result = await f.service.deleteCommunity(18, f.user);
  assert.deepEqual(result, { ok: true, removedEmptyBuildings: 3 });
  assert.equal(f.transactions, 1);
  assert.deepEqual(f.deleted, [
    Unit.name,
    CommunitySpot.name,
    QrCode.name,
    Building.name,
    Community.name,
  ]);
});

test('楼栋里真有房产时，提示户数而不是把空楼栋数说成房产', async () => {
  const f = fixture({ houses: 2 });
  await assert.rejects(
    () => f.service.deleteCommunity(18, f.user),
    /还有 2 户房产/,
  );
  assert.equal(f.transactions, 0);
});

test('无房产但有历史工单时，显示可搜索单号并保留地址档案', async () => {
  const f = fixture({ workOrders: [{ id: 76, orderNo: 'RX-TEST-0076' }] });
  await assert.rejects(
    () => f.service.deleteCommunity(18, f.user),
    /1 条历史工单（RX-TEST-0076）.*永久删除/,
  );
  assert.equal(f.transactions, 0);
  assert.deepEqual(f.deleted, []);
});
