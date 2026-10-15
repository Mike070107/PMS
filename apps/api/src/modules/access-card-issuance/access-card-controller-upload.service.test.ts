import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessCardIssuanceService, sanitizeParkingMovementRows } from './access-card-issuance.service';

const user = { id: 7, tenantId: 3 } as never;

test('多楼栋结果保留已成功楼栋，只重试失败楼栋', () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const merge = (service as unknown as {
    mergeAuthorizationResults: (operation: 'controller_upload', previous: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  }).mergeAuthorizationResults.bind(service);
  const first = merge('controller_upload', [], [
    { buildingId: 26, buildingNo: '26', status: 'controller_uploaded' },
    { buildingId: 20, buildingNo: '20', status: 'controller_failed', error: '离线' },
  ]);
  const second = merge('controller_upload', first, [
    { buildingId: 20, buildingNo: '20', status: 'controller_uploaded' },
  ]);
  assert.deepEqual(second.map((row) => [row.buildingNo, row.status]), [
    ['26', 'controller_uploaded'],
    ['20', 'controller_uploaded'],
  ]);
});

test('撤销权限保留已完成楼栋，只重试控制器或数据库未确认的楼栋', () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const merge = (service as unknown as {
    mergeAuthorizationResults: (operation: 'controller_revoke', previous: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  }).mergeAuthorizationResults.bind(service);
  const first = merge('controller_revoke', [], [
    { buildingId: 26, buildingNo: '26', status: 'controller_removed' },
    { buildingId: 20, buildingNo: '20', status: 'controller_failed', error: '门禁数据库回读失败' },
  ]);
  const second = merge('controller_revoke', first, [
    { buildingId: 20, buildingNo: '20', status: 'controller_removed' },
  ]);
  assert.deepEqual(second.map((row) => [row.buildingNo, row.status]), [
    ['26', 'controller_removed'],
    ['20', 'controller_removed'],
  ]);
});

function houseContext(accessStatus: string) {
  return {
    house: {
      id: 10,
      roomNo: '102',
      communityId: 228,
      communityName: '枫桦景苑二期',
      buildingId: 5,
      buildingNo: '5',
      lane: '228',
      roomKey: '228/5/102',
      displayAddress: '枫桦景苑二期 · 5号楼 · 102室',
    },
    projectPhase: 'phase2',
    accessSystem: 'mjsystem',
    routeReady: true,
    availableBuildings: [
      { id: 5, buildingNo: '5', accessSystem: 'mjsystem', routeReady: true },
      { id: 9, buildingNo: '9', accessSystem: 'mjsystem', routeReady: true },
    ],
    issuedCount: 1,
    nextSequence: 2,
    history: [{
      id: -11251,
      sequence: 1,
      legacyPersonNo: '11251',
      icCardNo: '11223344',
      wgCardNo: '05108721',
      issuedAt: '2026-09-22T02:20:00.000Z',
      accessStatus,
      legacySyncStatus: 'synced',
      controllerResults: [],
      latestAuthorization: null,
    }],
    historySources: {
      pms: true,
      legacy80: true,
      accessPermissions: true,
      accessPermissionsMessage: '已核验',
      message: '已合并',
    },
  };
}

test('未下发历史卡会创建本楼栋控制器下发任务', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.authorizationRepo = { findOne: async () => null };
  state.getHouseContext = async () => houseContext('not_uploaded');
  const queued: Array<Record<string, unknown>> = [];
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => {
    queued.push(input);
    return { status: 'pending' };
  };

  await service.uploadHistoryCardToController(
    10,
    -11251,
    { idempotencyKey: 'upload-controller-11251' },
    user,
  );

  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.historyId, -11251);
  assert.equal(queued[0]!.cardSequence, 1);
  assert.equal(queued[0]!.wgCardNo, '05108721');
  assert.deepEqual(queued[0]!.targetBuildings, [
    { id: 5, buildingNo: '5', accessSystem: 'mjsystem' },
  ]);
});

test('iCCard 远程开门只对选中的单栋建立独立任务', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.authorizationRepo = { findOne: async () => null };
  const context = houseContext('not_uploaded');
  context.availableBuildings.push({ id: 11, buildingNo: '11', accessSystem: 'iccard', routeReady: true });
  state.getHouseContext = async () => context;
  state.agentRepo = { find: async () => [{
    agentKey: 'access-gateway', kind: 'access_gateway', enabled: true, version: '2.5.45',
    status: 'online', lastSeenAt: new Date(), capabilities: { remoteDoorControl: true },
  }] };
  const queued: Array<Record<string, unknown>> = [];
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => { queued.push(input); return { status: 'pending' }; };

  await service.createDoorOperation(10, {
    buildingId: 11, operation: 'temporary_open', durationSeconds: 1800,
    idempotencyKey: 'door-open-building-11',
  }, user);

  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.historyId, 0);
  assert.equal(queued[0]!.wgCardNo, '__door_operation__');
  assert.equal(queued[0]!.durationSeconds, 1800);
  assert.deepEqual(queued[0]!.targetBuildings, [{ id: 11, buildingNo: '11', accessSystem: 'iccard' }]);
});

test('MjSystem 现场验证只允许26号楼立即远程开门', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.authorizationRepo = { findOne: async () => null };
  const context = houseContext('not_uploaded');
  context.availableBuildings.push({ id: 26, buildingNo: '26', accessSystem: 'mjsystem', routeReady: true });
  state.getHouseContext = async () => context;
  state.agentRepo = { find: async () => [{
    agentKey: 'access-gateway', kind: 'access_gateway', enabled: true, version: '2.5.45',
    status: 'online', lastSeenAt: new Date(), capabilities: { remoteDoorControl: true },
  }] };
  const queued: Array<Record<string, unknown>> = [];
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => { queued.push(input); return { status: 'pending' }; };

  await service.createDoorOperation(10, {
    buildingId: 26, operation: 'remote_open', idempotencyKey: 'mj26-controlled-open',
  }, user);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0]!.targetBuildings, [{ id: 26, buildingNo: '26', accessSystem: 'mjsystem' }]);

  await assert.rejects(service.createDoorOperation(10, {
    buildingId: 5, operation: 'remote_open', idempotencyKey: 'mj5-blocked-open',
  }, user), /仅允许 26 号楼/);
  await assert.rejects(service.createDoorOperation(10, {
    buildingId: 26, operation: 'temporary_open', durationSeconds: 300, idempotencyKey: 'mj26-blocked-temp',
  }, user), /仅允许 26 号楼立即远程开门/);
});

test('历史卡取消勾选只为真实已有权限的楼栋创建撤销任务', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.authorizationRepo = { findOne: async () => null };
  const context = houseContext('controller_uploaded');
  (context.history[0] as unknown as { controllerResults: Array<Record<string, unknown>> }).controllerResults = [{
    buildingNo: '9', accessSystem: 'mjsystem', controller: '9号楼控制器', door: '9号楼大门',
  }];
  state.getHouseContext = async () => context;
  state.agentRepo = { find: async () => [{
    agentKey: 'access-gateway', kind: 'access_gateway', enabled: true, version: '2.5.44',
    status: 'online', lastSeenAt: new Date(), capabilities: {
      accessDbWrite: true, controllerUpload: true, historicalAccessGrant: true,
    },
  }] };
  const queued: Array<Record<string, unknown>> = [];
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => { queued.push(input); return { status: 'pending' }; };

  await service.revokeHistoryAuthorization(10, -11251, {
    targetBuildingIds: [9], idempotencyKey: 'revoke-building-9',
  }, user);

  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.operation, 'controller_revoke');
  assert.deepEqual(queued[0]!.targetBuildings, [{ id: 9, buildingNo: '9', accessSystem: 'mjsystem' }]);
  await assert.rejects(
    service.revokeHistoryAuthorization(10, -11251, {
      targetBuildingIds: [5], idempotencyKey: 'revoke-never-authorized-building-5',
    }, user),
    /没有 5号楼 权限/,
  );
});

test('旧版助手不允许重试撤销权限任务', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  const task = {
    id: 81, tenantId: 3, houseId: 10, historyRowId: -11251, operation: 'controller_revoke',
    status: 'failed', attempt: 1, controllerResults: [], completedAt: new Date(),
    leaseAgentKey: null, leaseExpiresAt: null, lastError: '旧任务失败', updatedBy: null,
  };
  const query = {
    where: () => query, andWhere: () => query, getOne: async () => null,
  };
  state.authorizationRepo = { findOne: async () => task, createQueryBuilder: () => query };
  state.resolveHouse = async () => ({ id: 10 });
  state.agentRepo = { find: async () => [{
    agentKey: 'access-gateway', kind: 'access_gateway', enabled: true, version: '2.5.43',
    status: 'online', lastSeenAt: new Date(), capabilities: {
      accessDbWrite: true, controllerUpload: true, historicalAccessGrant: true,
    },
  }] };

  await assert.rejects(service.retryHistoryAuthorization(81, user), /2\.5\.44/);
});

test('旧版助手不会领取已排队的撤销权限任务', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  const clauses: string[] = [];
  const query = {
    where: (clause: string) => { clauses.push(clause); return query; },
    andWhere: (clause: string) => { clauses.push(clause); return query; },
    orderBy: () => query,
    setLock: () => query,
    setOnLocked: () => query,
    getOne: async () => null,
  };
  state.authenticateAgent = async () => ({
    agentKey: 'access-gateway', tenantId: 3, kind: 'access_gateway', version: '2.5.43',
    capabilities: { historicalAccessGrant: true },
  });
  state.authorizationRepo = {
    manager: {
      transaction: async (callback: (manager: { getRepository: () => { createQueryBuilder: () => typeof query } }) => Promise<unknown>) =>
        callback({ getRepository: () => ({ createQueryBuilder: () => query }) }),
    },
  };

  assert.deepEqual(await service.claimHistoryAuthorization('access-gateway', 'token'), { task: null });
  assert.equal(clauses.some((clause) => clause.includes('task.operation <>')), true);
});

test('已有权限的历史卡不会重复上传', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.authorizationRepo = { findOne: async () => null };
  state.getHouseContext = async () => houseContext('controller_uploaded');

  await assert.rejects(
    service.uploadHistoryCardToController(
      10,
      -11251,
      { idempotencyKey: 'upload-controller-duplicate' },
      user,
    ),
    /已下发控制器/,
  );
});

test('捷顺最新记录可以只添加到二期门禁数据库', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.legacySnapshotRepo = { findOne: async () => ({
    status: 'ready', history: [{ personId: 11251, personName: '228/5/102/1', icCardNo: '11223344' }],
  }) };
  state.recentLegacyCardResponse = async () => ({ rows: [{
    personId: 11251, canManageAccess: true, houseId: 10, wgCardNo: '05108721', actionMessage: null,
  }] });
  state.getHouseContext = async () => houseContext('not_uploaded');
  const queued: Array<Record<string, unknown>> = [];
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => {
    queued.push(input);
    return { status: 'pending' };
  };

  await service.operateRecentLegacyCard(
    11251,
    'access_database_only',
    { idempotencyKey: 'recent-access-db-11251' },
    user,
    { scopeAll: true } as never,
  );

  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.operation, 'access_database_only');
  assert.equal(queued[0]!.historyId, -11251);
  assert.deepEqual(queued[0]!.targetBuildings, [
    { id: 5, buildingNo: '5', accessSystem: 'mjsystem' },
  ]);
});

test('198弄一期捷顺记录不允许写入 .88 门禁系统', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.legacySnapshotRepo = { findOne: async () => ({
    status: 'ready', history: [{ personId: 19801, personName: '198/5/102/1', icCardNo: '11223344' }],
  }) };
  state.recentLegacyCardResponse = async () => ({ rows: [{
    personId: 19801, canManageAccess: false, houseId: 20, wgCardNo: null,
    actionMessage: '198弄一期卡不需要添加到 .88 门禁系统',
  }] });

  await assert.rejects(
    service.operateRecentLegacyCard(
      19801,
      'access_database_only',
      { idempotencyKey: 'recent-access-db-19801' },
      user,
      { scopeAll: true } as never,
    ),
    /198弄一期卡不需要添加/,
  );
});

test('最近发卡记录限制30条并遵守小区数据范围', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const batch = {
    houseId: 10,
    addressSnapshot: '228/5/102',
    projectPhase: 'phase2',
    accessSystem: 'mjsystem',
  };
  const query = {
    innerJoinAndSelect(...args: unknown[]) { calls.push({ method: 'innerJoinAndSelect', args }); return this; },
    where(...args: unknown[]) { calls.push({ method: 'where', args }); return this; },
    andWhere(...args: unknown[]) { calls.push({ method: 'andWhere', args }); return this; },
    orderBy(...args: unknown[]) { calls.push({ method: 'orderBy', args }); return this; },
    addOrderBy(...args: unknown[]) { calls.push({ method: 'addOrderBy', args }); return this; },
    limit(...args: unknown[]) { calls.push({ method: 'limit', args }); return this; },
    async getMany() {
      return [{
        id: 88, batchId: 9, batch, icCardNo: '11223344', wgCardNo: '05108721', legacyPersonNo: '11308',
        cardCompletedAt: new Date('2026-10-03T02:18:00.000Z'), accessStatus: 'controller_uploaded',
        legacySyncStatus: 'synced', controllerResults: [], lastErrorRef: null, lastErrorMessage: null,
      }];
    },
  };
  const state = service as unknown as Record<string, unknown>;
  state.itemRepo = { createQueryBuilder: () => query };

  const records = await service.getRecentCards(user, {
    scopeAll: false,
    communityIds: [228],
  } as never);

  assert.equal(records.length, 1);
  assert.equal(records[0]!.address, '228/5/102');
  assert.ok(calls.some((call) => call.method === 'limit' && call.args[0] === 30));
  assert.ok(!calls.some((call) => call.method === 'take'));
  assert.ok(calls.some((call) => call.method === 'orderBy'
    && call.args[0] === 'item.cardCompletedAt'));
  assert.ok(!calls.some((call) => call.method === 'orderBy'
    && call.args[0] === 'item.card_completed_at'));
  assert.ok(calls.some((call) => call.method === 'andWhere'
    && call.args[0] === 'batch.community_id IN (:...communityIds)'));
});

test('Car_Out 进出记录保留停车出入口，不把出入口冒充住户', async () => {
  const normalized = sanitizeParkingMovementRows([{
    database: 'parking2', fields: {
      carNo: '沪ATEST1', inTime: '2026-10-01 08:01:02', outTime: '2026-10-01 18:03:04',
      inGate: '二期入口', outGate: '二期出口', cardTypeName: null, personName: null,
    },
  }] as never, '沪ATEST1');
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, unknown>;
  state.parkingQueryRepo = { findOne: async () => ({
    id: 9, tenantId: 3, queryKind: 'movement', term: '沪ATEST1', status: 'completed',
    rangeStart: '2026-10-01', rangeEnd: '2026-10-01', rows: normalized,
    lastError: null, requestedAt: new Date(), completedAt: new Date(),
  }) };
  const result = await service.getParkingMovementQuery(9, user);
  assert.equal(result.movements[0]?.inGate, '二期入口');
  assert.equal(result.movements[0]?.outGate, '二期出口');
  assert.equal(result.movements[0]?.resident, null);
});
