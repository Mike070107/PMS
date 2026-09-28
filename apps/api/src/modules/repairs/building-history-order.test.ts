import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairsService } from './repairs.service';

function historyQueryBuilder() {
  const orders: Array<[string, 'ASC' | 'DESC']> = [];
  const builder = {
    orders,
    innerJoin() { return this; },
    where() { return this; },
    andWhere() { return this; },
    addSelect() { return this; },
    setParameter() { return this; },
    orderBy(field: string, direction: 'ASC' | 'DESC') {
      orders.push([field, direction]);
      return this;
    },
    addOrderBy(field: string, direction: 'ASC' | 'DESC') {
      orders.push([field, direction]);
      return this;
    },
    take() { return this; },
    async getMany() { return []; },
    async getCount() { return 0; },
  };
  return builder;
}

test('同楼栋历史分页排序使用 TypeORM 属性路径，并保持同房号优先、时间倒序', async () => {
  const builders: ReturnType<typeof historyQueryBuilder>[] = [];
  const service = Object.create(RepairsService.prototype) as any;
  service.repairRequestRepo = {
    createQueryBuilder() {
      const builder = historyQueryBuilder();
      builders.push(builder);
      return builder;
    },
  };

  await service.loadBuildingRepairHistory(1, 2, 3, 4);

  assert.deepEqual(builders[0].orders, [
    ['same_house_rank', 'ASC'],
    ['request.createdAt', 'DESC'],
    ['request.id', 'DESC'],
  ]);
  assert.equal(builders[0].orders.some(([field]) => field === 'request.created_at'), false);
});
