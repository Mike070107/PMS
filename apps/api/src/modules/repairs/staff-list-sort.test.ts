import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSync } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RepairsService } from './repairs.service';
import { WorkOrdersQueryDto } from './dto';
import { UserRole, WorkOrderStatus } from '../../common/enums';

function harness(count = 150) {
  const calls: any[][] = [];
  let take: number | undefined;
  const list = Array.from({ length: count }, (_, i) => ({
    id: i + 1, tenantId: 1, requestId: i + 1, communityId: i === count - 1 ? 2 : 1,
    createdAt: new Date('2026-01-01'), status: WorkOrderStatus.IN_PROGRESS, assigneeId: null,
    acceptedAt: null, completedAt: null,
  }));
  const requests = list.map((o, i) => ({
    id: o.id, communityId: o.communityId, createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    urgent: i === 0, attachments: [], content: '', addressText: `社区${o.id}号101`,
  }));
  const qb: any = { getMany: async () => list.slice(0, take) };
  for (const method of ['innerJoin', 'setFindOptions', 'addSelect', 'orderBy', 'addOrderBy']) {
    qb[method] = (...args: any[]) => { calls.push([method, ...args]); return qb; };
  }
  qb.take = (n: number) => { calls.push(['take', n]); take = n; return qb; };
  const service = Object.create(RepairsService.prototype) as any;
  Object.assign(service, {
    resolveTenantId: () => 1, autoCompleteExpiredReviews: async () => {}, scopeIds: () => null,
    keywordWheres: async (_tenant: number, where: any) => where,
    workOrderRepo: { createQueryBuilder: () => qb },
    repairRequestRepo: { find: async () => requests },
    dataSource: { getRepository: () => ({ find: async () => [] }) },
    communityAddressInfo: async () => new Map([[1, { name: '小区10', laneCount: 0 }], [2, { name: '小区2', laneCount: 0 }]]),
    repairTypeLabels: async () => new Map(), buildRequestAddressSummary: (r: any) => r?.addressText || '',
  });
  return { service, calls, list, requests, user: { id: 9, tenantId: 1, role: UserRole.STAFF }, access: { isTenantAdmin: true, pages: {}, scopeAll: true } };
}

test('API部署独立副本与共享比较器完全同源，防两端排序漂移', () => {
  const shared = readFileSync(join(__dirname, '../../../../../packages/shared-types/src/work-order-sort.ts'), 'utf8').replace(/\r\n/g, '\n');
  const copy = readFileSync(join(__dirname, '../../common/work-order-sort.shared.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(copy, shared);
});
test('全状态候选不被旧开放/完结分组打乱：越过300条后取排序前300', async () => {
  const h = harness(350);
  const rows = await h.service.listWorkOrders({ scope: 'all', sort: 'reported_desc' }, h.user, h.access);
  assert.equal(rows.length, 300);
  assert.deepEqual(rows.slice(0, 3).map((r: any) => r.id), [350, 349, 348]);
  assert.equal(rows.at(-1).id, 51);
  assert.equal(h.calls.some(c => c[0] === 'take'), false);
});

test('新增三个员工列表sort白名单，非法表达式仍拒绝', () => {
  for (const sort of ['reported_asc', 'reported_desc', 'address', 'newest', 'repair_time_desc']) {
    assert.deepEqual(validateSync(Object.assign(new WorkOrdersQueryDto(), { sort })), [], sort);
  }
  assert.ok(validateSync(Object.assign(new WorkOrdersQueryDto(), { sort: 'DROP TABLE' })).length);
});
test('全量候选排序后才取100：最新第150张越过旧take边界，紧急不插队', async () => {
  const h = harness();
  const rows = await h.service.listWorkOrders({ scope: 'all', status: WorkOrderStatus.IN_PROGRESS, sort: 'reported_desc' }, h.user, h.access);
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.slice(0, 3).map((r: any) => r.id), [150, 149, 148]);
  assert.equal(h.calls.some(c => c[0] === 'take'), false, '精排前不得截断数据库候选');
  assert.equal(rows[0].createdAt.getTime(), h.requests[149].createdAt.getTime());
});
test('小区名自然序优于随机ID，楼栋自然序；同小区保持聚合', async () => {
  const h = harness();
  const rows = await h.service.listWorkOrders({ scope: 'all', status: WorkOrderStatus.IN_PROGRESS, sort: 'address' }, h.user, h.access);
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.slice(0, 4).map((r: any) => r.id), [150, 1, 2, 3]);
  assert.equal(rows[0].communityName, '小区2');
  assert.equal(h.calls.some(c => c[0] === 'take'), false);
});
test('API下发结构化楼栋键，2号在10号前，同栋按报修时间而非房号', async () => {
  const h = harness(3);
  h.list.forEach(o => { o.communityId = 1; });
  h.requests.forEach((r, i) => { (r as any).buildingId = i === 1 ? 2 : 1; });
  h.requests[0].createdAt = new Date('2026-02-01');
  h.requests[2].createdAt = new Date('2026-01-01');
  h.requests[0].addressText = '10号101'; h.requests[2].addressText = '10号999';
  h.service.dataSource = { getRepository: () => ({ find: async () => [{ id: 1, lane: '1', buildingNo: '10' }, { id: 2, lane: '1', buildingNo: '2' }] }) };
  const rows = await h.service.listWorkOrders({ scope: 'all', status: WorkOrderStatus.IN_PROGRESS, sort: 'address' }, h.user, h.access);
  assert.deepEqual(rows.map((r: any) => r.id), [2, 3, 1]);
  assert.equal(rows[0].buildingNo, '2'); assert.equal(rows[0].buildingLane, '1');
});

test('在手完整清单不截断，仍按本人/租户权限where；正序不插急单', async () => {
  const h = harness(); h.requests[149].urgent = true;
  const rows = await h.service.listWorkOrders({ scope: 'mine', activeOnly: '1', sort: 'reported_asc' }, h.user, h.access);
  assert.equal(rows.length, 150);
  assert.deepEqual(rows.slice(0, 3).map((r: any) => r.id), [1, 2, 3]);
  const where = h.calls.find(c => c[0] === 'setFindOptions')?.[1]?.where;
  assert.equal(where.tenantId, 1); assert.equal(where.assigneeId, 9);
});
