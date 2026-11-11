import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairsService } from './repairs.service';
import { WorkOrderStatus, UserRole } from '../../common/enums';
import { DataSource } from 'typeorm';
import { WorkOrder } from '../../entities/work-order.entity';
import { RepairRequest } from '../../entities/repair-request.entity';
import { validateSync } from 'class-validator';
import { WorkOrdersQueryDto } from './dto';

test('排序参数仅接受显式的维修时间口径；省略时保持兼容', () => {
  assert.deepEqual(validateSync(new WorkOrdersQueryDto()), []);
  assert.deepEqual(validateSync(Object.assign(new WorkOrdersQueryDto(), { sort: 'repair_time_desc' })), []);
  assert.ok(validateSync(Object.assign(new WorkOrdersQueryDto(), { sort: 'request.createdAt DESC' })).some(e => e.property === 'sort'));
});

// 隔离单元测试：不连接业务库，不运行列表入口的自动验收写入。
function harness() {
  const calls: any[][] = [];
  const list = [
    { id: 1, acceptedAt: null, completedAt: null, dispatchedAt: new Date('2026-11-10') },
    { id: 2, acceptedAt: new Date('2026-11-07'), completedAt: null },
    { id: 3, acceptedAt: new Date('2026-11-08T08:00+08:00'), completedAt: null },
    { id: 4, acceptedAt: new Date('2026-11-08T00:00Z'), completedAt: null },
  ].map(o => ({ ...o, tenantId: 1, requestId: o.id, communityId: 1, createdAt: new Date('2026-01-01'), status: WorkOrderStatus.IN_PROGRESS }));
  const qb: any = {};
  for (const method of ['innerJoin', 'setFindOptions', 'addSelect', 'orderBy', 'addOrderBy', 'take']) {
    qb[method] = (...args: any[]) => { calls.push([method, ...args]); return qb; };
  }
  qb.getMany = async () => list;
  const service = Object.create(RepairsService.prototype) as any;
  Object.assign(service, {
    resolveTenantId: () => 1,
    autoCompleteExpiredReviews: async () => {},
    scopeIds: () => null,
    keywordWheres: async (_t: number, w: any) => w,
    workOrderRepo: { createQueryBuilder: () => qb },
    repairRequestRepo: { find: async () => list.map(o => ({ id: o.id, createdAt: new Date(`2026-11-0${o.id}`), urgent: o.id === 1, attachments: [] })) },
    communityAddressInfo: async () => new Map(),
    repairTypeLabels: async () => new Map(),
    buildRequestAddressSummary: () => '',
  });
  const user = { id: 9, tenantId: 1, role: UserRole.STAFF };
  const access = { isTenantAdmin: true, pages: {}, scopeAll: true };
  return { service, calls, user, access, list };
}

test('Web 调度排序在数据库 take 之前；响应不再被急单优先排序覆盖，报修时间来自 request', async () => {
  const h = harness();
  const rows = await h.service.listWorkOrders({ scope: 'all', status: WorkOrderStatus.IN_PROGRESS, sort: 'repair_time_desc' }, h.user, h.access);
  assert.deepEqual(rows.map((r: any) => r.id), [4, 3, 2, 1]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'orderBy' || c[0] === 'addOrderBy'), [
    ['orderBy', 'dispatch_repair_time', 'DESC', 'NULLS LAST'],
    ['addOrderBy', 'request.createdAt', 'DESC'],
    ['addOrderBy', 'wo.id', 'ASC'],
  ]);
  assert.ok(h.calls.findIndex(c => c[0] === 'orderBy') < h.calls.findIndex(c => c[0] === 'take'));
  assert.ok(h.calls.some(c => c[0] === 'addSelect' && c[1] === 'COALESCE(wo.completedAt, wo.acceptedAt)' && c[2] === 'dispatch_repair_time'));
  assert.equal(rows[0].createdAt.toISOString(), '2026-11-04T00:00:00.000Z');
});

test('小程序未选排序参数，继续沿用急修优先和先报先修，不扩大范围', async () => {
  const h = harness();
  const rows = await h.service.listWorkOrders({ scope: 'all', status: WorkOrderStatus.IN_PROGRESS }, h.user, h.access);
  assert.equal(rows[0].id, 1);
  assert.deepEqual(h.calls.filter(c => c[0] === 'orderBy' || c[0] === 'addOrderBy'), [
    ['orderBy', 'request.urgent', 'DESC'], ['addOrderBy', 'request.createdAt', 'ASC'], ['addOrderBy', 'wo.id', 'ASC'],
  ]);
});

test('TypeORM 实体映射后的维修排序表达式和分页别名可生成正确 SQL（离线，不连接 PostgreSQL）', async () => {
  const ds = new DataSource({ type: 'postgres', entities: [WorkOrder, RepairRequest] });
  await (ds as any).buildMetadatas();
  const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo')
    .innerJoin(RepairRequest, 'request', 'request.id = wo.requestId AND request.tenantId = wo.tenantId')
    .addSelect(['request.urgent', 'request.createdAt'])
    .addSelect('COALESCE(wo.completedAt, wo.acceptedAt)', 'dispatch_repair_time')
    .orderBy('dispatch_repair_time', 'DESC', 'NULLS LAST').addOrderBy('request.createdAt', 'DESC').addOrderBy('wo.id', 'ASC').take(100);
  assert.match(qb.getSql(), /COALESCE\("wo"\."completed_at", "wo"\."accepted_at"\) AS "dispatch_repair_time"/);
  const [select, order] = (qb as any).createOrderByCombinedWithSelectExpression('distinctAlias');
  assert.match(select, /"distinctAlias"\."dispatch_repair_time"/);
  assert.deepEqual(order['"distinctAlias"."dispatch_repair_time"'], { order: 'DESC', nulls: 'NULLS LAST' });
});

test('员工派单 newest 保留报修时间倒序，已完成使用完成时间倒序', async () => {
  const h = harness();
  let rows = await h.service.listWorkOrders({scope:'all',status:WorkOrderStatus.IN_PROGRESS,sort:'newest'},h.user,h.access);
  assert.deepEqual(rows.map((r:any)=>r.id),[4,3,2,1]);
  assert.ok(h.calls.some(c=>c[0]==='orderBy' && c[1]==='request.createdAt' && c[2]==='DESC'));
  h.list.forEach((row,i)=>{ row.completedAt = new Date(`2026-11-0${4-i}`) as any; });
  rows = await h.service.listWorkOrders({scope:'all',status:WorkOrderStatus.COMPLETED,sort:'newest'},h.user,h.access);
  assert.deepEqual(rows.map((r:any)=>r.id),[1,2,3,4]);
  assert.ok(h.calls.some(c=>c[0]==='orderBy' && c[1]==='wo.completedAt' && c[2]==='DESC'));
});
