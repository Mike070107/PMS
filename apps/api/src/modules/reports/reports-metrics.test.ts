import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportsService } from './reports.service';
import { StaffProfile, User } from '../../entities';

test('工单汇总同时输出总登记/待确认/已确认收费，feeCents 保留兼容', async () => {
  const service: any = Object.create(ReportsService.prototype);
  let sql = '';
  service.dataSource = {
    async query(text: string) {
      sql = text;
      return [{
        key: 'all', total: 58, completed: 40, pending_review: 2, cancelled: 1, active: 15, overdue: 3,
        avg_hours: '1.5', fee_cents: 31000, confirmed_fee_cents: 31000, pending_fee_cents: 0,
        total_fee_cents: 31000, material_cost_cents: 69500, avg_rating: 4.5, rating_count: 8,
      }];
    },
  };
  const rows = await service.aggregateWorkOrders(1, { fromTs: new Date(), toTs: new Date() }, null, {}, null);
  assert.match(sql, /confirmed_fee_cents/);
  assert.match(sql, /pending_fee_cents/);
  assert.match(sql, /total_fee_cents/);
  assert.deepEqual({
    feeCents: rows[0].feeCents,
    confirmedFeeCents: rows[0].confirmedFeeCents,
    pendingFeeCents: rows[0].pendingFeeCents,
    totalFeeCents: rows[0].totalFeeCents,
  }, { feeCents: 31000, confirmedFeeCents: 31000, pendingFeeCents: 0, totalFeeCents: 31000 });
});

test('维修工识别只认启用角色名含维修工，多角色去重', async () => {
  const service: any = Object.create(ReportsService.prototype);
  let params: any[] = [];
  service.dataSource = {
    async query(sql: string, values: any[]) {
      params = values;
      assert.match(sql, /r\.name LIKE '%维修工%'/);
      assert.match(sql, /r\.enabled = true/);
      assert.match(sql, /u\.status = 'active'/);
      return [{ user_id: 2 }, { user_id: 3 }];
    },
  };
  assert.deepEqual(await service.technicianUserIds(1), [2, 3]);
  assert.deepEqual(params, [1]);
});

test('人员统计默认 technician：staffCount、汇总、完工/在手都按维修工 assignee 过滤', async () => {
  const service: any = Object.create(ReportsService.prototype);
  const captured: any = {};
  service.resolveTenantId = () => 1;
  service.resolveRange = () => ({ fromTs: new Date('2026-10-10T00:00:00+08:00'), toTs: new Date('2026-11-09T00:00:00+08:00') });
  service.scopeIds = () => null;
  service.rangeView = () => ({});
  service.technicianUserIds = async () => [2, 3];
  service.staffIdsInScope = async (_tenant: number, ids: number[]) => ids;
  service.accessService = { userIdsWithPermission: async () => [2, 3], officeIdOfCommunity: async () => 1, userOfficeIds: async () => ({ all: true, officeIds: [] }) };
  service.skillLabelResolver = async () => (code: string) => code;
  service.aggregateWorkOrders = async (_tenant: number, _range: any, _scope: any, _query: any, groupBy: any, assigneeIds?: number[]) => {
    if (groupBy === 'assignee') captured.rowsIds = assigneeIds;
    else captured.summaryIds = assigneeIds;
    const base = { ...service.emptyAgg(), total: 1, completed: 1, feeCents: 100, confirmedFeeCents: 100, pendingFeeCents: 0, totalFeeCents: 100 };
    return groupBy === 'assignee' ? [2, 3].map((id) => ({ ...base, key: String(id) })) : [{ ...base, key: null }];
  };
  let repoCall = 0;
  service.dataSource = {
    async query(sql: string) {
      assert.match(sql, /assignee_id/);
      return [];
    },
    getRepository(entity: any) {
      return { async find() { return repoCall++ === 0
        ? [{ id: 2, name: '维修工甲', loginAccount: 'a', phone: null, status: 'active' }, { id: 3, name: '维修工乙', loginAccount: 'b', phone: null, status: 'active' }]
        : []; } };
    },
  };
  const out = await service.staff({}, { id: 1 }, { scopeAll: true } as any);
  assert.equal(out.jobTypes, 'technician');
  assert.equal(out.staffCount, 2);
  assert.deepEqual(captured.rowsIds, [2, 3]);
  assert.deepEqual(captured.summaryIds, [2, 3]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].totalFeeCents, 100);
  assert.equal(out.rows[0].pendingFeeCents, 0);
  assert.equal(out.summary.totalFeeCents, 100);
});
