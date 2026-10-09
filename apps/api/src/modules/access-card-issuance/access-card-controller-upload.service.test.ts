import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessCardIssuanceService, sanitizeParkingMovementRows } from './access-card-issuance.service';

const user = { id: 7, tenantId: 3 } as never;

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

test('未上传历史卡会创建本楼栋控制器上传任务', async () => {
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
    /已上传控制器/,
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
    take(...args: unknown[]) { calls.push({ method: 'take', args }); return this; },
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
  assert.ok(calls.some((call) => call.method === 'take' && call.args[0] === 30));
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
