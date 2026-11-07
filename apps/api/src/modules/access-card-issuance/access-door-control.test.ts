import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { AccessCardIssuanceController } from './access-card-issuance.controller';
import { AccessCardIssuanceService } from './access-card-issuance.service';

const user = { id: 7, tenantId: 3 } as never;
const scopeAll = { scopeAll: true } as never;
const community = { id: 228, name: '枫桦景苑二期', enabled: true } as never;
const iccardBuilding = { id: 11, communityId: 228, buildingNo: '11' } as never;
const mjsystemBuilding = { id: 26, communityId: 228, buildingNo: '26' } as never;

function makeService() {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, any>;
  const audits: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  state.requireTenant = () => 3;
  state.buildingRepo = {
    findOne: async ({ where }: { where: { id: number } }) =>
      [iccardBuilding, mjsystemBuilding].find((building: any) => building.id === where.id) ?? null,
    find: async () => [iccardBuilding, mjsystemBuilding],
  };
  state.communityRepo = {
    findOne: async ({ where }: { where: { id: number } }) => (where.id === 228 ? community : null),
    find: async () => [community],
  };
  state.agentRepo = {
    find: async () => [{
      agentKey: 'gateway', kind: 'access_gateway', enabled: true, status: 'online',
      lastSeenAt: new Date(), version: '2.5.48', capabilities: { remoteDoorControl: true },
    }],
  };
  state.authorizationRepo = {
    findOne: async () => null,
    find: async () => [],
    manager: { getRepository: () => ({ create: (value: unknown) => value, save: async (value: unknown) => value }) },
  };
  state.writeDoorAudit = async (tenantId: number, taskId: number, _building: unknown,
    dto: Record<string, unknown>, durationSeconds: number | null) => {
    audits.push({ tenantId, taskId, dto, durationSeconds });
  };
  state.createStandaloneDoorOperation = async (dto: Record<string, unknown>) => {
    created.push(dto);
    return {
      id: 501,
      houseId: 1,
      historyRowId: 0,
      roomKey: '228/11/1',
      cardSequence: null,
      operation: dto.operation,
      icCardNo: null,
      wgCardNo: '__door_operation__',
      targetBuildings: [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }],
      controllerResults: [],
      status: 'pending',
      attempt: 0,
      error: null,
      requestedAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: null,
      durationSeconds: dto.durationSeconds ?? null,
    };
  };
  return { service, state, audits, created };
}

function openDto(overrides: Record<string, unknown> = {}) {
  return {
    communityId: 228,
    controllerId: 11,
    doorNo: 11,
    operation: 'remote_open',
    idempotencyKey: 'door-open-0001',
    ...overrides,
  } as never;
}

test('door/open 复用既有授权任务通道并写审计', async () => {
  const { service, created, audits } = makeService();
  const result = await service.openDoor(openDto(), user, scopeAll);
  assert.equal((result as any).taskId, 501);
  assert.equal((result as any).status, 'pending');
  assert.equal((result as any).doorNo, 11);
  assert.equal((result as any).accessSystem, 'iccard');
  assert.equal(created.length, 1);
  assert.equal(created[0]!.operation, 'remote_open');
  assert.equal(created[0]!.durationSeconds, undefined);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.tenantId, 3);
  assert.equal(audits[0]!.taskId, 501);
  assert.equal((audits[0]!.dto as any).operation, 'remote_open');
});

test('temporary_open 只接受 1–60 分钟并换算为秒', async () => {
  const accepted = makeService();
  await accepted.service.openDoor(openDto({
    operation: 'temporary_open', minutes: 30, idempotencyKey: 'door-temp-0030',
  }), user, scopeAll);
  assert.equal(accepted.created[0]!.durationSeconds, 1800);

  for (const minutes of [0, 61, undefined]) {
    const { service } = makeService();
    await assert.rejects(
      service.openDoor(openDto({
        operation: 'temporary_open', minutes, idempotencyKey: `door-temp-${String(minutes)}`,
      }), user, scopeAll),
      /1–60 分钟/,
    );
  }
});

test('远程开门不接受 minutes，MjSystem 常开明确拒绝而不是失败重试', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.openDoor(openDto({ minutes: 5, idempotencyKey: 'door-open-extra' }), user, scopeAll),
    /不需要 minutes/,
  );

  const { service: mjService, created } = makeService();
  await assert.rejects(
    mjService.openDoor(openDto({
      controllerId: 26, doorNo: 26, operation: 'temporary_open', minutes: 5, idempotencyKey: 'door-mj-temp',
    }), user, scopeAll),
    /当前控制器不支持常开/,
  );
  assert.equal(created.length, 0);
});

test('doorNo 必须与楼栋唯一实体门一致', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.openDoor(openDto({ doorNo: 12, idempotencyKey: 'door-wrong-door' }), user, scopeAll),
    /门号应为 11/,
  );
  assert.equal(created.length, 0);
});

test('同一 idempotencyKey 返回原任务，不重复入队/审计', async () => {
  const { service, state, created, audits } = makeService();
  state.authorizationRepo.findOne = async () => ({
    id: 777,
    operation: 'remote_open',
    status: 'completed',
    targetBuildings: [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }],
    durationSeconds: null,
    controllerResults: [{ buildingNo: '11', status: 'door_opened', controller: '11号大门', door: '11号大门' }],
    lastError: null,
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:05.000Z'),
    attempt: 1,
  });
  const result = await service.openDoor(openDto({ idempotencyKey: 'door-idem-0001' }), user, scopeAll);
  assert.equal((result as any).taskId, 777);
  assert.equal((result as any).status, 'succeeded');
  assert.equal(created.length, 0);
  assert.equal(audits.length, 0);
});

test('任务状态映射 pending/sent/succeeded/failed 与控制器回执', () => {
  const { service } = makeService();
  const respond = (service as unknown as {
    doorTaskResponse: (task: Record<string, unknown>, building?: unknown) => Record<string, unknown>;
  }).doorTaskResponse.bind(service);
  const base = {
    id: 1,
    operation: 'remote_open',
    targetBuildings: [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }],
    durationSeconds: null,
    controllerResults: [{
      buildingNo: '11', status: 'door_opened', controller: '11号大门 / SN 55735',
      door: '11号大门', protocol: 'iCCard 0x7E / UDP', acknowledgement: '控制器已确认',
    }],
    lastError: null,
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: null,
    attempt: 1,
  };
  assert.equal(respond({ ...base, status: 'pending' }).status, 'pending');
  assert.equal(respond({ ...base, status: 'running' }).status, 'sent');
  assert.equal(respond({ ...base, status: 'completed' }).status, 'succeeded');
  const failed = respond({ ...base, status: 'failed', lastError: '控制器未确认' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '控制器未确认');
  assert.equal(respond({ ...base, status: 'completed' }).controller, '11号大门 / SN 55735');
});

test('getDoorTask 只接受门禁操作任务并按管理范围校验', async () => {
  const { service, state } = makeService();
  state.authorizationRepo.findOne = async () => ({
    id: 9,
    operation: 'temporary_open',
    status: 'completed',
    targetBuildings: [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }],
    durationSeconds: 1800,
    controllerResults: [{ buildingNo: '11', status: 'door_held_open', controller: '11号大门' }],
    lastError: null,
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:05.000Z'),
    attempt: 1,
  });
  const result = await service.getDoorTask(9, user, scopeAll);
  assert.equal((result as any).status, 'succeeded');
  assert.equal((result as any).minutes, 30);

  state.authorizationRepo.findOne = async () => ({
    id: 10, operation: 'controller_upload', status: 'completed', targetBuildings: [], durationSeconds: null,
    controllerResults: [], lastError: null, requestedAt: new Date(), completedAt: null, attempt: 0,
  });
  await assert.rejects(service.getDoorTask(10, user, scopeAll), /门禁控制任务不存在/);
});

test('门禁控制器在线状态由心跳 + 最近一次 agent 回执推导', async () => {
  const { service, state } = makeService();
  state.authorizationRepo.find = async () => [
    {
      id: 9,
      operation: 'controller_detect',
      status: 'completed',
      targetBuildings: [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }],
      controllerResults: [{ buildingNo: '11', controller: '11号大门 / SN 55735', door: '11号大门' }],
      requestedAt: new Date(), completedAt: new Date(), lastError: null,
    },
    {
      id: 10,
      operation: 'remote_open',
      status: 'failed',
      targetBuildings: [{ id: 26, buildingNo: '26', accessSystem: 'mjsystem' }],
      controllerResults: [],
      requestedAt: new Date(), completedAt: new Date(), lastError: '控制器未确认',
    },
  ];
  const result = await service.listDoorControllers(user, scopeAll, 228);
  assert.equal((result as any).agentOnline, true);
  const iccard = (result as any).controllers.find((row: any) => row.controllerId === 11);
  const mjsystem = (result as any).controllers.find((row: any) => row.controllerId === 26);
  assert.equal(iccard.status, 'online');
  assert.equal(iccard.supportTemporaryOpen, true);
  assert.equal(iccard.controllerName, '11号大门 / SN 55735');
  assert.equal(mjsystem.status, 'offline');
  assert.equal(mjsystem.supportTemporaryOpen, false);
  assert.equal(mjsystem.lastError, '控制器未确认');
});

test('审计回写包含结果、控制器回执和错误', async () => {
  const { service } = makeService();
  const saved: Array<Record<string, any>> = [];
  const repo = {
    findOne: async () => ({ detail: { taskId: 5, operation: 'remote_open' }, updatedBy: null }),
    save: async (value: Record<string, any>) => { saved.push(value); return value; },
  };
  const manager = { getRepository: () => repo };
  const task = {
    id: 5, tenantId: 3, createdBy: 7, operation: 'remote_open', status: 'completed', attempt: 1,
    controllerResults: [{ controller: '11号大门 / SN 55735', door: '11号大门', acknowledgement: '控制器已确认' }],
    lastError: null,
  };
  await (service as unknown as {
    updateDoorAudit: (manager: unknown, task: unknown) => Promise<void>;
  }).updateDoorAudit(manager, task);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.detail.result, 'succeeded');
  assert.equal(saved[0]!.detail.controller, '11号大门 / SN 55735');
  assert.equal(saved[0]!.detail.acknowledgement, '控制器已确认');
  assert.equal(saved[0]!.updatedBy, 7);
});

test('门禁接口沿用 access-cards 的 business edit/view 权限，不新增页面 key', () => {
  const handlers = AccessCardIssuanceController.prototype as unknown as Record<string, object>;
  const edit = Reflect.getMetadata(PERMISSION_KEY, handlers.openDoor!);
  const viewTask = Reflect.getMetadata(PERMISSION_KEY, handlers.doorTask!);
  const viewControllers = Reflect.getMetadata(PERMISSION_KEY, handlers.doorControllers!);
  assert.deepEqual(edit, { items: [{ pageKey: 'business', action: 'edit' }] });
  assert.deepEqual(viewTask, { items: [{ pageKey: 'business', action: 'view' }] });
  assert.deepEqual(viewControllers, { items: [{ pageKey: 'business', action: 'view' }] });
});
