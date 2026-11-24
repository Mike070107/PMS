import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { appendApproval } from '../../common/approval-log';

const user: any = { id: 7, tenantId: 1, role: 'manager' };
function fixture(keys: string[], data: Record<string, any[]> = {}, scope: number[] | null = null) {
  const access: any = { pages: Object.fromEntries(keys.map(k => [k, { view: true, edit: true }])), scopeAll: scope === null, communityIds: scope || [] };
  const calls: any[] = [];
  const db: any = { getRepository: (entity: any) => ({ find: async (query: any) => {
    calls.push([entity.name, query]);
    return (data[entity.name] || []).filter(r => r.tenantId === query.where.tenantId);
  } }) };
  const inventory: any = {
    approvalWarehouses: async () => data.warehouses || [{ id: 1, name: '发货仓' }, { id: 2, name: '接收仓' }],
    listPurchaseRequests: async () => (data.purchases || []).map(r => ({ createdAt: '2026-11-01T00:00:00Z', ...r })),
    approveTransferOrder: async (...args: any[]) => { calls.push(['approve', ...args]); return { status: 'in_transit' }; },
    rejectTransferOrder: async (...args: any[]) => { calls.push(['reject', ...args]); return { status: 'rejected' }; },
  };
  const families: any = { approvalRows: async () => data.families || [], get: async (id: number) => data.families?.find(r => r.id === id) };
  const maintenance: any = { listSignTasks: async () => data.signs || [] };
  const business: any = { decideReview: async (...args: any[]) => { calls.push(['business', ...args]); } };
  const vehicles: any = { get: async (id: number) => data.VehicleIntake?.find(r => r.id === id) };
  const stocktakes: any = { approvalRows: async () => data.stocktakes || [] };
  return { service: new ApprovalsService(db, inventory, families, maintenance, business, vehicles, stocktakes), access, calls, inventory };
}
const transfer = (extra = {}) => ({ id: 1, tenantId: 1, transferNo: 'TR-001', fromWarehouseId: 1, toWarehouseId: 2, status: 'pending_review', items: [{ materialId: 10, qty: 3 }], createdAt: '2026-11-01T00:00:00Z', ...extra });

test('dual purchase roles collect both stages; personal history uses actual decision time only', async () => {
  const f = fixture(['app:approve-purchase-manager', 'app:approve-purchaser'], { purchases: [
    { id: 1, requestNo: 'PR1', status: 'manager_review', approvalLog: [{ userId: 7, at: '2026-11-02T00:00:00Z', stage: 'manager', result: '经理通过' }] },
    { id: 2, requestNo: 'PR2', status: 'purchaser_review', updatedAt: '2026-11-17T00:00:00Z', approvalLog: [{ userId: 7, at: '2026-11-03T00:00:00Z', stage: 'purchaser', result: '采购通过' }, { userId: 9, at: '2026-11-04T00:00:00Z', stage: 'manager', result: '经理通过' }] },
    { id: 3, requestNo: 'PR3', status: 'approved', managerApproverId: 7, updatedAt: new Date(), approvalLog: [] },
  ] });
  const pending = await f.service.list({}, user, f.access);
  assert.equal(pending.tabs.pending, 2);
  const done = await f.service.list({ tab: 'done' }, user, f.access);
  assert.deepEqual(done.rows.map(r => r.id), [2, 1]);
  assert.equal(done.total, 2);
  assert.equal(done.rows[0].at, '2026-11-03T00:00:00.000Z');
});

test('transfer requires both visible warehouses for pending, personal history and action', async () => {
  const f = fixture(['app:approve-purchase-manager'], { warehouses: [{ id: 1, name: '仓1' }], TransferOrder: [transfer(), transfer({ id: 2, status: 'in_transit', approverId: 7, approvedAt: new Date() })] });
  const result = await f.service.list({}, user, f.access);
  assert.deepEqual(result.tabs, { pending: 0, done: 0 });
  await assert.rejects(() => f.service.decide('transfer', 1, true, '', user, f.access));
  assert.ok(!f.calls.some(c => c[0] === 'approve'));
});

test('legacy manager permission can approve scoped transfer and rejection requires reason', async () => {
  const f = fixture(['app:approve-manager'], { TransferOrder: [transfer()] });
  const result = await f.service.list({}, user, f.access);
  assert.equal(result.rows[0].category, 'transfer');
  assert.match((result.rows[0].detail as any).lines, /3/);
  await assert.rejects(() => f.service.decide('transfer', 1, false, '  ', user, f.access));
  await f.service.decide('transfer', 1, true, '', user, f.access);
  assert.ok(f.calls.some(c => c[0] === 'approve' && c[1] === 1));
});

test('view-only access and another tenant cannot supply actionable rows', async () => {
  const f = fixture(['app:approve-manager'], { TransferOrder: [transfer({ tenantId: 2 })] });
  assert.equal((await f.service.list({}, user, f.access)).total, 0);
  f.access.pages['app:approve-manager'].edit = false;
  await assert.rejects(() => f.service.decide('transfer', 1, true, '', user, f.access));
  await assert.rejects(() => f.service.list({}, { ...user, tenantId: null }, f.access));
});

test('counts/search/pagination are independent of category, no legacy 100/200 row truncation', async () => {
  const f = fixture(['app:approve-business-manager', 'app:stocktakes'], {
    BusinessTransaction: Array.from({ length: 225 }, (_, i) => ({ id: i + 1, tenantId: 1, communityId: 3, txnNo: `BUS-${i}`, serviceType: 'parking_monthly', externalSyncStatus: 'review', createdBy: 8, snapshot: { review: { required: true } }, createdAt: '2026-11-01' })),
    stocktakes: Array.from({ length: 125 }, (_, i) => ({ id: i + 1, taskNo: `ST-${i}`, warehouseName: '盘点仓', status: 'submitted', createdAt: '2026-11-01' })),
  });
  const result = await f.service.list({ category: 'business', page: '12', pageSize: '20' }, user, f.access);
  assert.equal(result.tabs.pending, 350);
  assert.equal(result.total, 225);
  assert.equal(result.rows.length, 5);
  assert.equal(result.hasMore, false);
  assert.equal(result.categories.find(c => c.key === 'stocktake')?.count, 125);
  const search = await f.service.list({ q: 'ST-', category: 'all' }, user, f.access);
  assert.equal(search.allCount, 125);
  assert.equal(search.tabs.pending, 350);
});

test('收费经理可以处理自己登记的单据，审批权限和小区范围仍须匹配', async () => {
  const row = { id: 1, tenantId: 1, communityId: 3, serviceType: 'parking_monthly', externalSyncStatus: 'review', createdBy: 7,
    txnNo: 'PK-1', amountCents: 5000, createdAt: '2026-11-23', snapshot: { review: { required: true } } };
  const data = { BusinessTransaction: [row, { ...row, id: 2, communityId: 4 }, { ...row, id: 3, tenantId: 2 }] };
  const f = fixture(['app:approve-business-manager'], data, [3]);
  assert.deepEqual((await f.service.list({}, user, f.access)).rows.map(item => item.id), [row.id]);
  await f.service.decide('business', row.id, true, '', user, f.access);
  assert.ok(f.calls.some(call => call[0] === 'business' && call[1] === row.id && call[4] === user));
  for (const id of [2, 3]) await assert.rejects(f.service.decide('business', id, true, '', user, f.access), /可审批范围/);
  f.access.pages['app:approve-business-manager'].edit = false;
  await assert.rejects(f.service.decide('business', row.id, true, '', user, f.access), /可审批范围/);
  const limited = fixture(['app:approve-business-manager'], data, []);
  assert.equal((await limited.service.list({}, user, limited.access)).total, 0);
});

test('category failures propagate; never report a partially successful zero count', async () => {
  const f = fixture(['app:approve-manager']);
  f.inventory.listPurchaseRequests = async () => { throw new Error('network unavailable'); };
  await assert.rejects(() => f.service.list({}, user, f.access), /network unavailable/);
});

test('append log preserves previous decisions after edit/resubmit instead of replacing reviewer fields', () => {
  const row = { approvalLog: [{ userId: 7, at: '2026-11-01T00:00:00Z', stage: 'manager', result: '整单驳回' }] };
  appendApproval(row, 7, 'manager', '经理通过');
  assert.equal(row.approvalLog.length, 2);
  assert.equal(row.approvalLog[0].result, '整单驳回');
  assert.ok(Number.isFinite(new Date(row.approvalLog[1].at).getTime()));
});

test('office rejection belongs to summary history instead of manager approval history', async () => {
  const f = fixture(['app:inventory'], { purchases: [{ id: 1, requestNo: 'PR-OFFICE', status: 'rejected', approvalLog: [{ userId: 7, at: '2026-11-03', stage: 'office_review', result: '整单驳回' }] }] });
  const result = await f.service.list({ tab: 'done' }, user, f.access);
  assert.equal(result.rows[0].category, 'summary');
});

test('notification read failure cannot turn committed transfer decision into client failure', async () => {
  let called = 0;
  const controller = new ApprovalsController({ decide: async () => { called++; return { status: 'in_transit' }; } } as any, { markReadByRef: async () => { throw new Error('synthetic notification failure'); } } as any);
  (controller as any).logger = { warn: () => undefined };
  const result = await controller.decide('transfer', 9, { approved: true }, user, {} as any);
  assert.equal(result.status, 'in_transit');
  assert.equal(called, 1);
});

test('unauthenticated QR signing never attributes requester as personal approver; authenticated sign does', () => {
  const apply = (MaintenanceService.prototype as any).applySignedSlot;
  const service = { assertExpectedSlot() {} };
  const external: any = { approvalLog: [], fillerId: null };
  apply.call(service, external, 'filler', '/synthetic.png', 7, '链接请求人');
  assert.equal(external.approvalLog.length, 0);
  const authenticated: any = { approvalLog: [], fillerId: null };
  apply.call(service, authenticated, 'filler', '/synthetic.png', 7, '本人登录', true);
  assert.equal(authenticated.approvalLog.length, 1);
  assert.equal(authenticated.approvalLog[0].userId, 7);
});
