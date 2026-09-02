import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole, WorkOrderStatus } from '../common/enums';
import { InventoryService } from './inventory/inventory.service';
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

function appAccess(pages: Record<string, { view: boolean }>) {
  return {
    isPlatformAdmin: false,
    isTenantAdmin: false,
    scopeAll: true,
    communityIds: [],
    pages,
  } as any;
}

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

test('维修工的工单池不再按候选人或当前负责人过滤', async () => {
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

  assert.equal(capturedWhere.assigneeId, undefined);
  assert.equal(capturedWhere.candidateIds, undefined);
  assert.deepEqual(capturedWhere.status._value, [
    WorkOrderStatus.CREATED,
    WorkOrderStatus.DISPATCHED,
    WorkOrderStatus.WAITING_MATERIAL,
  ]);

  assert.deepEqual(
    await service.listWorkOrders(
      { scope: 'pool', status: WorkOrderStatus.IN_PROGRESS },
      user,
      access,
    ),
    [],
  );
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

test('已派给别人但尚未接单的工单，可从工单池主动接走', async () => {
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
  let logNote = '';
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => {};
  service.lockWorkOrder = async () => workOrder;
  service.writeLog = async (
    _manager: any,
    _saved: any,
    _from: any,
    _action: string,
    _operatorId: number,
    note: string,
  ) => {
    logNote = note;
  };
  service.dataSource = {
    async transaction(run: (manager: any) => Promise<any>) {
      return run({ async save(_entity: any, value: any) { return value; } });
    },
  };

  const saved = await service.acceptWorkOrder(6, { id: 7, tenantId: 1 }, {});

  assert.equal(saved.assigneeId, 7);
  assert.deepEqual(saved.candidateIds, [7]);
  assert.equal(saved.status, WorkOrderStatus.IN_PROGRESS);
  assert.match(logNote, /原已派给其他维修工/);
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
