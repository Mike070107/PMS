import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairsService } from './repairs.service';
import { ExtractSamplesService } from '../ai/extract-samples.service';
import { RepairTextAiService } from '../ai/repair-text.ai';
import { UserStatus, WorkOrderStatus } from '../../common/enums';

/** Tenant-aware in-memory repository: actual services, no external DB or notifications. */
function samplesFixture() {
  let nextId = 1;
  const rows: any[] = [];
  const matches = (row: any, where: any): boolean => Object.entries(where || {}).every(([key, value]: any) => {
    if (value && typeof value === 'object' && '_type' in value) {
      if (value._type === 'in') return value._value.includes(row[key]);
      if (value._type === 'raw' && key === 'expected') return row.expected?._officeId === undefined
        || row.expected?._officeId === value._objectLiteralParameters.sampleOfficeId;
      return false;
    }
    return row[key] === value;
  });
  const repo: any = {
    create: (row: any) => ({ ...row }),
    count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
    find: async ({ where, take }: any = {}) => rows.filter((row) => matches(row, where)).sort((a, b) => b.id - a.id).slice(0, take || 10000),
    findOne: async ({ where }: any) => [...rows].reverse().find((row) => matches(row, where)) || null,
    save: async (input: any): Promise<any> => {
      if (Array.isArray(input)) return Promise.all(input.map(repo.save));
      const row = { ...input, id: input.id || nextId++, updatedAt: new Date() };
      const index = rows.findIndex((item) => item.id === row.id);
      if (index < 0) rows.push(row); else rows[index] = row;
      return row;
    },
    remove: async (row: any) => { rows.splice(rows.findIndex((item) => item.id === row.id), 1); },
  };
  return { samples: new ExtractSamplesService(repo), rows, repo };
}

const types = [
  { repairType: 'intercom', label: '楼宇对讲', keywords: ['对讲', '话机'] },
  { repairType: 'electric', label: '电气', keywords: ['插座'] },
];

test('未知单办公室默认通知只含显式本管理处工作人员，不把all权限当通知归属', async () => {
  const service: any = Object.create(RepairsService.prototype);
  service.accessService = {
    officeIdOfCommunity: async () => 10,
    userIdsWithPermission: async () => [1, 2, 3, 4, 5],
    filterUsersCoveringOffice: async () => new Map([[1, 'all'], [2, 'office'], [3, 'office'], [4, 'all']]),
    assignmentsOf: async () => new Map([
      [1, [{ officeId: null, skills: [] }]],
      [2, [{ officeId: 10, skills: [] }]],
      [3, [{ officeId: 20, skills: [] }]],
      [4, [{ officeId: null, skills: [] }, { officeId: 10, skills: [] }]],
      [5, [{ officeId: 10, skills: [] }]],
    ]),
  };
  service.settings = { getDispatchNoticeRecipients: async () => null };
  service.userRepo = { find: async ({ where }: any) => where.id._value.filter((id: number) => id !== 5).map((id: number) => ({ id, tenantId: 7, status: UserStatus.ACTIVE })) };
  assert.deepEqual((await service.dispatchersToNotify(7, 100, null, true)).map((row: any) => row.id), [2, 4]);
  service.settings.getDispatchNoticeRecipients = async () => [];
  assert.deepEqual(await service.dispatchersToNotify(7, 100, null, true), []);
  service.accessService.officeIdOfCommunity = async () => null;
  assert.deepEqual(await service.dispatchersToNotify(7, 100, null, true), []);
});

test('办公室一次派单即写入可删除类别样例；类别只在对应租户管理处生效，不记维修工', async () => {
  const { samples, rows } = samplesFixture();
  await (samples as any).rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'intercom');
  const learned = rows.find((row) => row.expected?._classificationOnly);
  assert.ok(learned);
  assert.deepEqual(Object.keys(learned.expected).sort(), ['_classificationOnly', '_officeId', 'repairType'].sort());
  assert.equal(learned.kind, 'repair');
  assert.equal(learned.expected.repairType, 'intercom');
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', 20), null);
  assert.equal(await samples.findExact(8, '家里话机没信号', 'repair', 10), null);
  assert.equal((await samples.findExact(7, '家里话机没信号', 'repair', 10))?.id, learned.id);
  await (samples as any).rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'electric');
  assert.equal(rows.filter((row) => row.expected?._classificationOnly).length, 1);
  assert.equal((await samples.findExact(7, '家里话机没信号', 'repair', 10))?.expected.repairType, 'electric');
});

test('删除错误样例清除精确命中及prompt影响，下次用AI；删光种子也不重生', async () => {
  const { samples } = samplesFixture();
  await samples.list(7);
  for (const row of await samples.list(7)) await samples.remove(7, row.id);
  assert.deepEqual(await samples.list(7), []);
  await (samples as any).rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'electric');
  let calls = 0;
  const ai = new RepairTextAiService({ askJson: async () => { calls++; return { repairType: 'intercom', description: '家里话机没信号', contactName: '测试人', addressText: '测试位置', publicArea: true }; } } as any, samples);
  const first = await ai.parse(7, '家里话机没信号', types, 10);
  assert.equal(first?.repairType, 'electric');
  assert.equal(calls, 1, '类别样例不应跳过其它字段的AI识别');
  assert.equal(first?.description, '家里话机没信号');
  assert.equal(first?.contactName, '测试人');
  assert.equal(first?.addressText, '测试位置');
  assert.equal(first?.publicArea, true, '其它字段沿用实际AI识别，不把类别样例缺失字段填空');
  const row = await samples.findExact(7, '家里话机没信号', 'repair', 10);
  await samples.remove(7, row!.id);
  calls = 0;
  const second = await ai.parse(7, '家里话机没信号', types, 10);
  assert.equal(second?.repairType, 'intercom');
  assert.equal(calls, 1);
  assert.deepEqual(await samples.forPrompt(7, 'repair', '家里话机没信号', 10), []);
});

test('识别类别后候选按管理处技能匹配，不记上次被指派的人、不跨管理处/租户', async () => {
  const service: any = Object.create(RepairsService.prototype);
  service.accessService = {
    officeIdOfCommunity: async () => 10,
    userIdsWithPermission: async () => [1, 2, 3, 4],
    filterUsersCoveringOffice: async () => new Map([[1, 'office'], [2, 'office'], [4, 'all']]),
    skillsAtOfficeOf: async () => new Map([[1, ['intercom']], [2, ['electric']], [3, ['intercom']], [4, ['intercom']]]),
    userHasPermission: async () => true,
  };
  service.userRepo = { find: async ({ where }: any) => where.id._value.map((id: number) => ({ id, tenantId: 7, status: id === 4 ? UserStatus.DISABLED : UserStatus.ACTIVE })) };
  const result = await service.ruleCandidates(7, { enabled: true, repairType: 'intercom', assigneeIds: [], assigneeId: null }, 100);
  assert.deepEqual(result.map((row: any) => row.id), [1]);
});

function dispatchFixture() {
  const f = samplesFixture();
  const request: any = { id: 20, tenantId: 7, content: '家里话机没信号', repairType: null };
  const order: any = { id: 99, tenantId: 7, requestId: 20, communityId: 100, status: WorkOrderStatus.CREATED, skill: null };
  const service: any = Object.create(RepairsService.prototype);
  service.resolveTenantId = () => 7;
  service.scopeIds = () => null;
  service.accessService = { officeIdOfCommunity: async () => 10 };
  service.workOrderRepo = { findOne: async () => order };
  service.repairRequestRepo = { findOne: async () => request };
  service.userRepo = { findOne: async () => ({ id: 12, tenantId: 7, name: '本处维修工' }) };
  service.findTypeRule = async (type: string) => type === 'electric' ? { repairType: type, enabled: true } : null;
  service.assertAssignee = async () => {};
  service.lockWorkOrder = async () => order;
  service.captureWorkOrderSnapshot = async () => ({});
  service.writeLog = async () => {};
  service.notifyOwnerOnStatus = async () => {};
  service.notifyAssigneeOnDispatch = async () => {};
  service.extractSamples = f.samples;
  service.logger = { warn: () => {} };
  service.dataSource = { transaction: async (fn: any) => fn({ findOne: async () => request, save: async (_entity: any, row: any) => row }) };
  return { ...f, service, request, order };
}

test('正式assignWorkOrder提交成功→样例保存→下一次guessRepairType读取→删除后回到规则/AI', async () => {
  const f = dispatchFixture();
  await f.service.assignWorkOrder(99, { assigneeId: 12, skill: 'electric' }, { id: 8, tenantId: 7 });
  assert.equal(f.request.repairType, 'electric');
  assert.equal(f.order.assigneeId, 12);
  const sample = await f.samples.findExact(7, f.request.content, 'repair', 10);
  assert.equal(sample?.expected.repairType, 'electric');
  f.service.rulesForCommunity = async () => types.map((row) => ({ ...row, enabled: true, suggestions: row.keywords }));
  assert.equal(await f.service.guessRepairType(f.request.content, 7, 100), 'electric');
  await f.samples.remove(7, sample!.id);
  assert.equal(await f.service.guessRepairType(f.request.content, 7, 100), 'intercom');
  assert.deepEqual(f.order.candidateIds, [12], '原单的人工派单保留，不因删样例追改历史工单');
});

test('派单无效类别、越范围、事务失败均不学习', async () => {
  const f = dispatchFixture();
  await assert.rejects(f.service.assignWorkOrder(99, { assigneeId: 12, skill: 'disabled' }, { id: 8, tenantId: 7 }), /不存在或已停用/);
  f.service.scopeIds = () => [200];
  await assert.rejects(f.service.assignWorkOrder(99, { assigneeId: 12, skill: 'electric' }, { id: 8, tenantId: 7 }), /not found/);
  f.service.scopeIds = () => null;
  f.service.dataSource.transaction = async () => { throw new Error('transaction failed'); };
  await assert.rejects(f.service.assignWorkOrder(99, { assigneeId: 12, skill: 'electric' }, { id: 8, tenantId: 7 }), /transaction failed/);
  assert.equal(f.rows.filter((row) => row.expected?._classificationOnly).length, 0);
});

test('种子删除状态跨服务重建保持，普通编辑不能伪造或移除学习作用域', async () => {
  const { samples, repo } = samplesFixture();
  for (const row of await samples.list(7)) await samples.remove(7, row.id);
  const restarted = new ExtractSamplesService(repo);
  assert.deepEqual(await restarted.list(7), []);
  const learned = await samples.rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'intercom');
  await samples.update(7, 8, learned!.id, { expected: { repairType: 'electric', _officeId: 20 } });
  assert.equal((await samples.findExact(7, '家里话机没信号', 'repair', 10))?.expected._officeId, 10);
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', 20), null);
  const forged = await samples.create(7, 8, { text: '伪造元数据', expected: { repairType: 'electric', _officeId: 10, _classificationOnly: true } });
  assert.deepEqual(forged.expected, { repairType: 'electric' });
  await samples.update(7, 8, learned!.id, { enabled: false });
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', 10), null);
  assert.ok(!(await samples.forPrompt(7, 'repair', '', 10)).some((row) => row.id === learned!.id));
  await assert.rejects(samples.remove(8, learned!.id), /样例不存在/);
});

for (const officeId of [10, null]) {
  test(`真实新建/转单/超时入口共用管理处通知边界：office=${officeId}`, async () => {
    const f = dispatchFixture();
    const sent: any[] = [];
    const calls: any[] = [];
    f.order.createdAt = new Date('2026-11-16T00:00:00Z');
    f.order.orderNo = 'RX-TEST';
    f.order.assigneeId = null;
    f.request.repairType = null;
    f.service.accessService = {
      officeIdOfCommunity: async () => officeId,
      userIdsWithPermission: async () => [1, 2, 3],
      assignmentsOf: async () => new Map([[1, [{ officeId: null, skills: [] }]], [2, [{ officeId: 10, skills: [] }]], [3, [{ officeId: 20, skills: [] }]]]),
    };
    f.service.settings = { getDispatchNoticeRecipients: async (...args: any[]) => { calls.push(args); return null; } };
    f.service.userRepo.find = async ({ where }: any) => where.id._value.map((id: number) => ({ id, tenantId: 7, status: UserStatus.ACTIVE }));
    f.service.notifications = { notifyUser: async (input: any) => { sent.push(input); return { reason: 'local fixture', externalSent: false }; } };
    f.service.findTypeRule = async () => null;
    f.service.logger = { warn: () => {}, error: () => {} };
    f.service.workOrderRepo.update = async () => {};
    f.service.dataSource.getRepository = () => ({ create: (row: any) => row, save: async (row: any) => row });
    f.service.urgeReceivers = async () => [];
    await f.service.notifyCandidatesOnCreate(f.order, [], null);
    await f.service.notifyOfficeOnTransfer(f.order, '类别不匹配', 88);
    await f.service.escalateOne(f.order, 30);
    assert.deepEqual(sent.map((item) => item.receiverId), officeId ? [2, 2, 2] : []);
    assert.deepEqual(sent.map((item) => item.eventKey), officeId ? ['order_pool_unassigned', 'order_transfer_requested', 'order_accept_overdue_office'] : []);
    assert.ok(calls.every((args) => args[0] === 7 && args[1] === 10));
  });
}
