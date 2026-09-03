import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole, WorkOrderStatus } from '../common/enums';
import { InventoryService } from './inventory/inventory.service';
import { AiFeedbackService } from './ai/ai-feedback.service';
import { RepairFeeRulesService } from './ai/repair-fee-rules.service';
import { OfficesService } from './offices/offices.service';
import { PropertiesService } from './properties/properties.service';
import { QrService } from './qr/qr.service';
import { RepairsService } from './repairs/repairs.service';
import { SettingsService } from './settings/settings.service';

const scopedResolvers = [
  ['inventory', Object.create(InventoryService.prototype)],
  ['properties', Object.create(PropertiesService.prototype)],
  ['repairs', Object.create(RepairsService.prototype)],
  ['qr', Object.create(QrService.prototype)],
] as const;

test('company view tenant scope wins over the superadmin role', () => {
  const acting = { id: 1, role: UserRole.SUPERADMIN, tenantId: 7 };
  for (const [name, service] of scopedResolvers) {
    assert.equal(
      (service as any).resolveTenantId(acting),
      7,
      `${name} should use the verified acting tenant`,
    );
    assert.throws(
      () => (service as any).resolveTenantId(acting, 8),
      `${name} should reject a tenant that conflicts with company view`,
    );
  }

  const settings = Object.create(SettingsService.prototype) as SettingsService;
  assert.equal((settings as any).requireTenant(acting), 7);
});

test('bare superadmin still needs an explicit tenant outside company view', () => {
  const platform = { id: 1, role: UserRole.SUPERADMIN, tenantId: null };
  for (const [name, service] of scopedResolvers) {
    assert.equal(
      (service as any).resolveTenantId(platform, 9),
      9,
      `${name} should support explicit platform operations`,
    );
    assert.throws(
      () => (service as any).resolveTenantId(platform),
      `${name} should reject an unscoped platform request`,
    );
  }
});

test('按编号读取或操作工单时仍校验管理处小区范围', () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.scopeIds = () => [10, 11];
  assert.doesNotThrow(() => service.assertWorkOrderScope({ communityId: 10 }, {}));
  assert.throws(
    () => service.assertWorkOrderScope({ communityId: 99 }, {}),
    /work order not found/,
  );
});

test('按库存/仓库编号操作时仍校验可见仓范围', async () => {
  const service = Object.create(InventoryService.prototype) as any;
  service.visibleWarehouseIds = async () => [3, 4];
  const user = { id: 7, tenantId: 1 };
  await assert.doesNotReject(() => service.assertWarehouseVisible(1, user, 3, {}));
  await assert.rejects(
    () => service.assertWarehouseVisible(1, user, 9, {}),
    /warehouse not found/,
  );
});

test('员工地址簿只返回业务角色范围内的小区，空范围不是全公司', async () => {
  const service = Object.create(PropertiesService.prototype) as any;
  service.buildAddressTree = async () => [
    { id: 10, parentId: 1, name: '枫桦景苑一期' },
    { id: 11, parentId: 1, name: '枫桦景苑二期' },
    { id: 20, parentId: null, name: '其它小区' },
  ];
  const user = { id: 7, role: UserRole.STAFF, tenantId: 1 } as any;
  const scoped = { scopeAll: false, communityIds: [10, 11] } as any;

  assert.deepEqual(
    (await service.getAddressBook(undefined, user, scoped)).map((item: any) => item.id),
    [10, 11],
  );
  await assert.rejects(
    () => service.getAddressBook(20, user, scoped),
    /community not found/,
  );
  assert.deepEqual(
    await service.getAddressBook(undefined, user, {
      scopeAll: false,
      communityIds: [],
    }),
    [],
  );
});

test('员工报修地址识别在空数据范围时不会退化成全公司匹配', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.communityRepo = {
    async find() {
      return [{ id: 20, parentId: null, tenantId: 1, enabled: true, name: '其它小区' }];
    },
  };

  const result = await service.parseAddressByRule(
    { text: '其它小区大门坏了' },
    { id: 7, role: UserRole.STAFF, tenantId: 1 },
    { scopeAll: false, communityIds: [] },
  );
  assert.deepEqual(result, { matched: false });
});

test('员工不能伪造其它管理处的小区编号提交报修', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  const user = { id: 7, role: UserRole.STAFF, tenantId: 1 } as any;

  await assert.rejects(
    () => service.submitOwnerRepair(
      { communityId: 20 },
      user,
      { scopeAll: false, communityIds: [10, 11] },
    ),
    /该小区不在你的管理范围内/,
  );
});

test('管理处列表按任意员工角色的数据范围过滤，不按角色名称判断', () => {
  const service = Object.create(OfficesService.prototype) as any;
  const communities = [
    { id: 10, parentId: null, officeId: 1 },
    { id: 11, parentId: 10, officeId: null },
    { id: 20, parentId: null, officeId: 2 },
  ];
  assert.deepEqual(
    [...service.officeIdsInScope([10, 11], communities)],
    [1],
  );
  assert.deepEqual(
    [...service.officeIdsInScope([20], communities)],
    [2],
  );
  assert.equal(service.officeIdsInScope(null, communities), null);
});

test('报修类型配置只能维护角色完整覆盖的管理处', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.accessService = {
    async officeCommunityIds() {
      return [10, 11];
    },
  };
  await assert.doesNotReject(() =>
    service.assertRuleOfficeInScope(1, 1, {
      scopeAll: false,
      communityIds: [10, 11],
    }),
  );
  await assert.rejects(
    () => service.assertRuleOfficeInScope(1, 1, {
      scopeAll: false,
      communityIds: [10],
    }),
    /管理处不存在/,
  );
  await assert.rejects(
    () => service.assertRuleOfficeInScope(1, null, {
      scopeAll: false,
      communityIds: [10, 11],
    }),
    /全公司报修类型模板/,
  );
});

test('采购申请按工单小区或申请人所属管理处过滤', async () => {
  const service = Object.create(InventoryService.prototype) as any;
  service.dataSource = {
    getRepository() {
      return {
        async find() {
          return [
            { id: 101, communityId: 10 },
            { id: 102, communityId: 20 },
          ];
        },
      };
    },
  };
  service.accessService = {
    async officeIdOfCommunity(_tenantId: number, communityId: number) {
      return communityId === 10 ? 1 : 2;
    },
    async userOfficeIds(_tenantId: number, userId: number) {
      return userId === 8
        ? { all: false, officeIds: [1] }
        : { all: false, officeIds: [2] };
    },
  };
  const rows = [
    { id: 1, workOrderId: 101, applicantId: 7 },
    { id: 2, workOrderId: 102, applicantId: 7 },
    { id: 3, workOrderId: null, applicantId: 8 },
    { id: 4, workOrderId: null, applicantId: 9 },
  ];
  const visible = await service.filterPurchaseRequestsByAccess(
    1,
    rows,
    { id: 7, tenantId: 1, role: UserRole.STAFF },
    { scopeAll: false, communityIds: [10] },
  );
  assert.deepEqual(visible.map((row: any) => row.id), [1, 3]);
});

test('AI 纠错记录按关联工单小区过滤，未关联记录只允许本人查看', async () => {
  const service = Object.create(AiFeedbackService.prototype) as any;
  service.workOrderRepo = {
    async find() {
      return [
        { id: 101, communityId: 10 },
        { id: 102, communityId: 20 },
      ];
    },
  };
  const rows = [
    { id: 1, workOrderId: 101, createdBy: 8 },
    { id: 2, workOrderId: 102, createdBy: 7 },
    { id: 3, workOrderId: null, createdBy: 7 },
    { id: 4, workOrderId: null, createdBy: 8 },
  ];
  const visible = await service.filterByAccess(
    1,
    rows,
    { id: 7, tenantId: 1, role: UserRole.STAFF },
    { scopeAll: false, communityIds: [10] },
  );
  assert.deepEqual(visible.map((row: any) => row.id), [1, 3]);
});

test('收费规则只能由完整覆盖对应管理处的角色维护', async () => {
  const service = Object.create(RepairFeeRulesService.prototype) as any;
  service.accessService = {
    async officeCommunityIds() {
      return [10, 11];
    },
  };
  await assert.doesNotReject(() =>
    service.assertOfficeManageable(1, 1, {
      scopeAll: false,
      communityIds: [10, 11],
    }),
  );
  await assert.rejects(
    () =>
      service.assertOfficeManageable(1, 1, {
        scopeAll: false,
        communityIds: [10],
      }),
    /维修收费规则不存在/,
  );
  await assert.rejects(
    () =>
      service.assertOfficeManageable(1, null, {
        scopeAll: false,
        communityIds: [10, 11],
      }),
    /维修收费规则不存在/,
  );
});

function appAccess(pages: Record<string, { view: boolean }>) {
  return {
    isPlatformAdmin: false,
    isTenantAdmin: false,
    scopeAll: true,
    communityIds: [],
    pages,
  } as any;
}

test('工单联表分页排序把关联表排序列加入内层查询', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let selected: string[] | undefined;
  const queryBuilder = {
    innerJoin() { return this; },
    setFindOptions() { return this; },
    addSelect(columns: string[]) { selected = columns; return this; },
    orderBy() { return this; },
    addOrderBy() { return this; },
    take() { return this; },
    async getMany() { return []; },
  };
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => null;
  service.isSelfScoped = async () => false;
  service.canDispatch = async () => true;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    createQueryBuilder() { return queryBuilder; },
  };

  await service.listWorkOrders(
    { scope: 'all' },
    { id: 7, role: UserRole.STAFF, tenantId: 1 },
    appAccess({ 'work-orders': { view: true } }),
  );

  assert.deepEqual(selected, ['request.urgent', 'request.createdAt']);
});

test('「我的报修」权限只能读本人提交的列表，不能借 scope 越权看工单池', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => null;
  service.repairRequestRepo = {
    async find() {
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:my-repairs': { view: true } });

  await assert.doesNotReject(() =>
    service.listWorkOrders({ scope: 'reported' }, user, access),
  );
  await assert.rejects(
    () => service.listWorkOrders({ scope: 'pool' }, user, access),
    /没有查看这类工单的权限/,
  );
  await assert.rejects(
    () => service.listWorkOrders({ scope: 'mine' }, user, access),
    /没有查看这类工单的权限/,
  );
});

test('「在手工单」不再隐式授予「我的报修」列表权限', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => null;
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:my-orders': { view: true } });

  await assert.rejects(
    () => service.listWorkOrders({ scope: 'reported' }, user, access),
    /没有查看这类工单的权限/,
  );
});

test('维修工的工单池包含公开待接单和派给本人的待接单', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let capturedWhere: any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => [10];
  service.isSelfScoped = async () => false;
  service.canDispatch = async () => false;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:pool': { view: true } });

  await service.listWorkOrders({ scope: 'pool' }, user, access);

  assert.equal(Array.isArray(capturedWhere), true);
  assert.equal(capturedWhere[0].assigneeId, undefined);
  assert.equal(capturedWhere[0].candidateIds, undefined);
  assert.deepEqual(capturedWhere[0].status._value, [
    WorkOrderStatus.CREATED,
    WorkOrderStatus.WAITING_MATERIAL,
  ]);
  assert.equal(capturedWhere[1].status, WorkOrderStatus.DISPATCHED);
  assert.equal(capturedWhere[1].assigneeId, 7);

  assert.deepEqual(
    await service.listWorkOrders(
      { scope: 'pool', status: WorkOrderStatus.IN_PROGRESS },
      user,
      access,
    ),
    [],
  );
});

test('派单台只列没有负责人且没有候选维修工的新单', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let capturedWhere: any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => [10];
  service.isSelfScoped = async () => false;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:dispatch': { view: true } });

  await service.listWorkOrders({ scope: 'dispatch' }, user, access);

  assert.equal(capturedWhere.assigneeId._type, 'isNull');
  assert.equal(capturedWhere.candidateIds._type, 'raw');
  assert.match(capturedWhere.candidateIds._getSql('candidate_ids'), /jsonb_array_length/);
  assert.equal(capturedWhere.status, WorkOrderStatus.CREATED);
});

test('同时有派单权限的人打开工单池时仍按工单池范围取数', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let capturedWhere: any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => [10];
  service.isSelfScoped = async () => false;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:pool': { view: true }, 'app:dispatch': { view: true } });

  await service.listWorkOrders({ scope: 'pool' }, user, access);

  assert.equal(Array.isArray(capturedWhere), true);
  assert.equal(capturedWhere[0].assigneeId, undefined);
  assert.equal(capturedWhere[0].candidateIds, undefined);
  assert.deepEqual(capturedWhere[0].status._value, [
    WorkOrderStatus.CREATED,
    WorkOrderStatus.WAITING_MATERIAL,
  ]);
  assert.equal(capturedWhere[1].status, WorkOrderStatus.DISPATCHED);
  assert.equal(capturedWhere[1].assigneeId, 7);
});

test('在手工单排除尚未确认接单的定向派单', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let capturedWhere: any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => [10];
  service.isSelfScoped = async () => false;
  service.canDispatch = async () => false;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:my-orders': { view: true } });

  await service.listWorkOrders({ scope: 'mine' }, user, access);

  assert.equal(capturedWhere.assigneeId, 7);
  assert.equal(capturedWhere.status._type, 'not');
  assert.equal(capturedWhere.status._value._type, 'in');
  assert.deepEqual(capturedWhere.status._value._value, [
    WorkOrderStatus.CREATED,
    WorkOrderStatus.DISPATCHED,
  ]);
});

test('定向已派单只进入对应维修工的工单池', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let capturedWhere: any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => [10];
  service.isSelfScoped = async () => false;
  service.keywordWheres = async (_tenantId: number, where: any) => [where];
  service.workOrderRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [];
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;
  const access = appAccess({ 'app:pool': { view: true } });

  await service.listWorkOrders(
    { scope: 'pool', status: WorkOrderStatus.DISPATCHED },
    user,
    access,
  );

  assert.equal(capturedWhere.status, WorkOrderStatus.DISPATCHED);
  assert.equal(capturedWhere.assigneeId, 7);
});

test('有工单池接单权时，可认领未推送给自己的未派单', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  const workOrder = {
    id: 5,
    tenantId: 1,
    communityId: 10,
    status: WorkOrderStatus.CREATED,
    assigneeId: null,
    candidateIds: [],
    escalatedAt: new Date(),
  };
  let logAction = '';
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => {};
  service.lockWorkOrder = async () => workOrder;
  service.writeLog = async (_manager: any, _saved: any, _from: any, action: string) => {
    logAction = action;
  };
  service.dataSource = {
    async transaction(run: (manager: any) => Promise<any>) {
      return run({ async save(_entity: any, value: any) { return value; } });
    },
  };

  const saved = await service.acceptWorkOrder(5, { id: 7, tenantId: 1 }, {});

  assert.equal(saved.assigneeId, 7);
  assert.deepEqual(saved.candidateIds, [7]);
  assert.equal(saved.status, WorkOrderStatus.IN_PROGRESS);
  assert.equal(saved.escalatedAt, null);
  assert.equal(logAction, 'claim');
});

test('已派给别人的工单不能被其他维修工主动接走', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  const workOrder = {
    id: 6,
    tenantId: 1,
    communityId: 10,
    status: WorkOrderStatus.DISPATCHED,
    assigneeId: 99,
    candidateIds: [99],
    escalatedAt: new Date(),
  };
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => {};
  service.lockWorkOrder = async () => workOrder;
  service.writeLog = async () => {};
  service.dataSource = {
    async transaction(run: (manager: any) => Promise<any>) {
      return run({ async save(_entity: any, value: any) { return value; } });
    },
  };

  await assert.rejects(
    () => service.acceptWorkOrder(6, { id: 7, tenantId: 1 }, {}),
    /工单已派给其他维修工/,
  );
  assert.equal(workOrder.assigneeId, 99);
  assert.equal(workOrder.status, WorkOrderStatus.DISPATCHED);
});

test('只有「我的报修」权限时，不能打开别人提交的工单详情', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.autoCompleteExpiredReviews = async () => {};
  service.scopeIds = () => null;
  service.workOrderRepo = {
    async findOne() {
      return { id: 5, tenantId: 1, communityId: 10, requestId: 20, assigneeId: 99 };
    },
  };
  service.repairRequestRepo = {
    async findOne() {
      return { id: 20, tenantId: 1, submittedBy: 8 };
    },
  };
  service.dataSource = {
    getRepository() {
      return { async find() { return []; } };
    },
  };
  const user = { id: 7, role: 'staff', tenantId: 1 } as any;

  await assert.rejects(
    () => service.getWorkOrder(5, user, appAccess({ 'app:my-repairs': { view: true } })),
    /work order not found/,
  );
});
