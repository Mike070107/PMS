import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessCardIssuanceService } from './access-card-issuance.service';

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
