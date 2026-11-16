import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole, WorkOrderStatus } from '../../common/enums';
import { RepairsService } from './repairs.service';
import { composePlaceText, scopeIds } from '../../../../miniapp-owner/miniprogram/utils/place-scope';

function fixture(name = '永南140弄', lane = '140') {
  const request = Object.freeze({
    id: 134, tenantId: 1, submittedBy: 7, communityId: 8, buildingId: 11, houseId: null,
    addressText: `${name}/${lane}弄6号 大门`, content: '大门一直异响',
    source: 'owner_miniapp', repairType: 'menjing', attachments: [],
    contactName: '测试住户', contactPhone: '13800000000',
  });
  const order = { id: 134, tenantId: 1, requestId: 134, communityId: 8,
    orderNo: 'RX-TEST', assigneeId: 2, status: WorkOrderStatus.CREATED,
    createdAt: new Date('2026-11-16T00:51:00Z'), resultAttachments: [],
  };
  const messages: any[] = [];
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.workOrderRepo = { findOne: async () => order };
  service.repairRequestRepo = { findOne: async () => request };
  service.userRepo = { findOne: async () => ({ id: 2, name: '测试维修工' }) };
  service.dataSource = { getRepository: () => ({
    find: async () => [], findOne: async () => null,
    create: (x: unknown) => x, save: async (x: unknown) => x,
  }), query: async () => [] };
  service.notifications = {
    markReadByRef: async () => {},
    notifyUser: async (x: any) => { messages.push(x); return { externalSent: true, reason: 'mock accepted' }; },
  };
  service.storage = { toDisplayUrls: (x: unknown) => x || [] };
  service.resolveContact = async () => null;
  service.repairTypeLabels = async () => new Map();
  service.registeredAddressText = async () => null;
  service.findTypeRule = async () => ({ label: '门禁相关' });
  return { service, request, order, messages };
}

for (const [name, lane] of [['永南140弄', '140'], ['永南150弄', '150'], ['永北150弄', '150']]) {
  test(`真实建单/派单/业主状态通知统一去重，保留${name}和大门，不改快照`, async () => {
    const f = fixture(name, lane);
    await f.service.notifyCandidatesOnCreate(f.order, [{ id: 2, name: '维修工' }], 7);
    await f.service.notifyAssigneeOnDispatch(f.order, null);
    await f.service.notifyOwnerOnStatus(f.order, 'dispatched', '维修工');
    await f.service.notifyOwnerOnStatus(f.order, 'review', '维修工');
    assert.equal(f.messages.length, 4);
    for (const message of f.messages) {
      assert.equal(message.templateFields.address, `${name}6号 大门`);
      assert.ok(!message.title.includes(`/${lane}弄`));
      assert.equal(message.payload.workOrderId, 134);
    }
    assert.equal(f.request.addressText, `${name}/${lane}弄6号 大门`);
    assert.deepEqual([f.request.communityId, f.request.buildingId, f.request.houseId], [8, 11, null]);
  });

  test(`真实详情返回${name}去重文案，历史实体冻结且ID不变`, async () => {
    const f = fixture(name, lane);
    const result = await f.service.getWorkOrder(134, { id: 7, tenantId: 1, role: UserRole.OWNER });
    assert.equal(result.request.addressText, `${name}6号 大门`);
    assert.equal(f.request.addressText, `${name}/${lane}弄6号 大门`);
    assert.deepEqual([result.request.communityId, result.request.buildingId, result.request.houseId], [8, 11, null]);
    assert.notEqual(result.request, f.request);
    assert.equal(result.request.content, '大门一直异响');
  });
}

test('详情地址展示不能绕过报修人权限', async () => {
  const f = fixture();
  await assert.rejects(f.service.getWorkOrder(134, { id: 99, tenantId: 1, role: UserRole.OWNER }), /work order not found/);
});

test('列表自由文本回退去重，但不丢位置、不改原始地址', () => {
  const f = fixture();
  assert.equal(f.service.buildRequestAddressSummary(f.request, new Map(), new Map()), '永南140弄6号 大门');
  assert.equal(f.request.addressText, '永南140弄/140弄6号 大门');
});

test('不同弄号在通知和详情中绝不能误删', async () => {
  const f = fixture('永南1140弄', '140');
  await f.service.notifyCandidatesOnCreate(f.order, [{ id: 2 }], 7);
  const result = await f.service.getWorkOrder(134, { id: 7, tenantId: 1, role: UserRole.OWNER });
  assert.equal(f.messages[0].templateFields.address, '永南1140弄/140弄6号 大门');
  assert.equal(result.request.addressText, '永南1140弄/140弄6号 大门');
});

for (const action of ['contact', 'format-only', 'new-place']) {
  test(`编辑往返不应把显示去重误记成地址更正：${action}`, async () => {
    const f = fixture();
    const request = { ...f.request };
    const notes: string[] = [];
    f.service.repairRequestRepo = { findOne: async () => request };
    f.service.canDispatch = async () => true;
    f.service.communityRepo = { findOne: async () => ({ id: 8, name: '永南140弄' }) };
    f.service.buildingRepo = { findOne: async () => ({ id: 11, communityId: 8, lane: '140', buildingNo: '6' }) };
    f.service.rulesForCommunity = async () => [{ repairType: 'menjing', enabled: true }];
    f.service.ruleCandidates = async () => [];
    f.service.communityAddressInfo = async () => new Map([[8, { name: '永南140弄' }]]);
    f.service.dataSource.transaction = async (fn: any) => fn({ save: async () => {} });
    f.service.writeLog = async (...args: any[]) => notes.push(args[5]);
    const dto = {
      communityId: 8, buildingId: 11, content: request.content, repairType: 'menjing', urgent: false,
      addressText: action === 'new-place' ? '永南140弄6号 东门' : '永南140弄6号 大门',
      contactName: action === 'contact' ? '新联系人' : request.contactName,
      contactPhone: request.contactPhone,
    };
    const save = () => f.service.updateWorkOrderIntake(134, dto, { id: 7, tenantId: 1, role: UserRole.OWNER });
    if (action === 'format-only') {
      await assert.rejects(save(), /报修信息没有变化/);
      assert.equal(notes.length, 0);
    } else {
      await save();
      assert.equal(request.addressText, action === 'new-place' ? dto.addressText : f.request.addressText);
      assert.equal(notes[0].includes('地址「'), action === 'new-place');
    }
  });
}

for (const name of ['永南150弄', '永北150弄']) {
  test(`数字房号通知与详情直接连接，${name}身份ID及历史快照保持`, async () => {
    const f = fixture(name, '150');
    const raw = Object.freeze({ ...f.request, houseId: 17, addressText: `${name}/150弄6号/201` });
    f.service.repairRequestRepo = { findOne: async () => raw };
    await f.service.notifyOwnerOnStatus(f.order, 'dispatched', '维修工');
    const result = await f.service.getWorkOrder(134, { id: 7, tenantId: 1, role: UserRole.OWNER });
    assert.equal(f.messages[0].templateFields.address, `${name}6号201`);
    assert.equal(result.request.addressText, `${name}6号201`);
    assert.deepEqual([result.request.communityId, result.request.buildingId, result.request.houseId], [8, 11, 17]);
    assert.equal(raw.addressText, `${name}/150弄6号/201`);
  });
}

test('真实通用报修服务接受仅小区公区，事务保存照片并详情回读，不放宽跨租户校验', async () => {
  const f = fixture();
  const saved: any[] = [];
  const manager = {
    create: (_entity: any, data: any) => ({ ...data }),
    save: async (entity: any, data: any) => {
      const row = { ...data, id: 134, createdAt: new Date('2026-11-16T02:00:00Z') };
      saved.push({ entity: entity.name, row }); return row;
    },
    query: async () => [],
  };
  f.service.communityRepo = { findOne: async ({ where }: any) => where.id === 8 && where.tenantId === 1 ? { id: 8, tenantId: 1, name: '永南150弄' } : null };
  f.service.buildingRepo = { findOne: () => { throw new Error('小区公区不得借用楼栋'); } };
  f.service.houseRepo = { findOne: () => { throw new Error('小区公区不得借用住户'); } };
  f.service.dataSource.transaction = async (fn: any) => fn(manager);
  f.service.resolveContact = async () => ({ name: '测试代报', phone: null });
  f.service.ruleCandidates = async () => [];
  f.service.nextOrderNo = async () => 'RX-PUBLIC-TEST';
  f.service.rememberContactAsOwner = async () => {};
  f.service.notifyCandidatesOnCreate = async () => {};
  const dto = { communityId: 8, addressText: '永南150弄/公共区域 南门', locationText: '南门', content: '门异响', repairType: 'menjing', attachments: ['/api/upload/file?key=test.png'] };
  const user = { id: 7, tenantId: 1, role: UserRole.OWNER };
  const created = await f.service.submitOwnerRepair(dto, user);
  assert.equal(created.request.buildingId, null); assert.equal(created.request.houseId, null);
  assert.deepEqual(created.request.attachments, dto.attachments);
  assert.equal(saved.filter(x => x.entity === 'RepairRequest').length, 1);
  assert.equal(saved.filter(x => x.entity === 'WorkOrder').length, 1);
  assert.equal(saved.filter(x => x.entity === 'WorkOrderLog').length, 1);
  f.service.repairRequestRepo = { findOne: async () => created.request };
  f.service.workOrderRepo = { findOne: async () => created.workOrder };
  const detail = await f.service.getWorkOrder(134, user);
  assert.deepEqual(detail.request.attachments, dto.attachments);
  assert.equal(detail.request.addressText, dto.addressText);
  assert.equal(detail.request.communityId, 8);
  await assert.rejects(f.service.submitOwnerRepair({ ...dto, communityId: 9 }, user), /community not found/);
  assert.equal(saved.length, 3, '拒绝后不得新增任何事务行');
});

test('业主报修范围拼接同样去重，摘房号规则不变', () => {
  const base = { communityName: '永北150弄', buildingText: '150弄6号', homeText: '永北150弄/150弄6号/201' };
  assert.equal(composePlaceText('home', base), '永北150弄6号201');
  assert.equal(composePlaceText('building', base, '楼道'), '永北150弄6号 楼道');
  assert.equal(composePlaceText('community', base, '大门'), '永北150弄 大门');
  assert.deepEqual(scopeIds('building', { buildingId: 11, houseId: 17 }), { buildingId: 11, houseId: undefined });
  assert.deepEqual(scopeIds('community', { buildingId: 11, houseId: 17 }), { buildingId: undefined, houseId: undefined });
});
