import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { mapLegacyCardRow } from './legacy-card-history.util';
import { icToWg } from './access-card-routing';

const user = { id: 7, tenantId: 3 } as never;
const scopeAll = { scopeAll: true } as never;

const toIso = (milliseconds: number) => new Date(milliseconds).toISOString();
const rawRows = [
  {
    personId: 26412, personNo: '11296', sequence: 8, icCardNo: 'B9F7D803',
    issuedAt: toIso(1794207499000), personName: '228/50/202/8', cardInfoId: 12026,
    personCreatedAt: toIso(1794207426000), lastSwipeAt: null, lastDevice: null,
  },
  {
    personId: 26411, personNo: '11295', sequence: 7, icCardNo: '9B8FD803',
    issuedAt: toIso(1794207475000), personName: '228/50/202/7', cardInfoId: 12025,
    personCreatedAt: toIso(1794207426000), lastSwipeAt: null, lastDevice: null,
  },
  {
    personId: 26410, personNo: '11294', sequence: 6, icCardNo: 'BA81D603',
    issuedAt: toIso(1794207452000), personName: '228/50/202/6', cardInfoId: 12024,
    personCreatedAt: toIso(1794207426000), lastSwipeAt: null, lastDevice: null,
  },
  {
    personId: 23100, personNo: '00007993', sequence: 5, icCardNo: '5FB481B9',
    issuedAt: toIso(1521008919000), personName: '228/50/202/5', cardInfoId: 8763,
    personCreatedAt: toIso(1521008542263), lastSwipeAt: toIso(1563956624000), lastDevice: '3号岗入口',
  },
  {
    personId: 20407, personNo: '00005600', sequence: 4, icCardNo: '3355F180',
    issuedAt: toIso(1388302377000), personName: '已隐藏228/50/202/4', cardInfoId: 5633,
    personCreatedAt: toIso(1512538738403), lastSwipeAt: null, lastDevice: null,
  },
  {
    personId: 20406, personNo: '00005599', sequence: 3, icCardNo: 'B4A3C4B9',
    issuedAt: toIso(1388302375000), personName: '已隐藏228/50/202/3', cardInfoId: 5632,
    personCreatedAt: toIso(1512538738403), lastSwipeAt: toIso(1605490393000), lastDevice: '2号岗入口',
  },
  {
    personId: 20405, personNo: '00005598', sequence: 2, icCardNo: '7325EA80',
    issuedAt: toIso(1388302373000), personName: '已隐藏228/50/202/2', cardInfoId: 5631,
    personCreatedAt: toIso(1512538738403), lastSwipeAt: toIso(1604302556000), lastDevice: '3号岗出口',
  },
  {
    personId: 20404, personNo: '00005597', sequence: 1, icCardNo: 'A39CEC80',
    issuedAt: toIso(1388302370000), personName: '已隐藏228/50/202/1', cardInfoId: 5630,
    personCreatedAt: toIso(1512538738403), lastSwipeAt: toIso(1605175287000), lastDevice: '3号岗入口',
  },
];

const snapshot: any = {
  id: 1,
  tenantId: 3,
  roomKey: '228/50/202',
  status: 'ready',
  history: rawRows,
  permissions: [],
  permissionStatus: 'ready',
  refreshedAt: new Date(),
};

function makeService() {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, any>;
  const enqueued: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let nextTaskId = 900;
  const context = {
    community: { id: 2, name: '枫桦景苑二期' },
    building: { id: 119, buildingNo: '50', lane: '228' },
    house: { id: 1435, roomNo: '202' },
    roomKey: '228/50/202',
    legacyStorageRoomKey: '228/50/202',
  };
  state.requireTenant = () => 3;
  state.legacySnapshotRepo = {
    findOne: async () => snapshot,
    find: async () => [snapshot],
    save: async (value: unknown) => value,
    create: (value: unknown) => value,
  };
  state.requestLegacyHistory = async () => snapshot;
  state.waitLegacyHistory = async () => snapshot;
  state.resolveLegacyRoomByInput = async () => context;
  state.findLegacyCardById = async () => ({ row: rawRows[0], snapshot });
  state.resolveLegacyCardRoom = async () => context;
  state.writeLegacyCardAudit = async (...args: unknown[]) => { audits.push({ args }); return undefined; };
  state.enqueueHistoryAuthorization = async (input: Record<string, unknown>) => {
    enqueued.push(input);
    const target = (input.targetBuildings as Array<{ buildingNo: string }>)[0];
    if (target?.buildingNo === '41') throw new Error('41 号楼控制器离线');
    nextTaskId += 1;
    return { id: nextTaskId };
  };
  state.authorizationRepo = {
    find: async () => [],
    manager: { getRepository: () => ({ create: (value: unknown) => value, save: async (value: unknown) => value }) },
  };
  state.buildingRepo = {
    find: async () => [
      { id: 119, buildingNo: '50' },
      { id: 41, buildingNo: '41' },
      { id: 26, buildingNo: '26' },
    ],
  };
  state.agentRepo = {
    find: async ({ where }: { where: { kind: string } }) => where.kind === 'legacy_sync'
      ? [{
        agentKey: 'legacy', kind: 'legacy_sync', enabled: true, status: 'online',
        lastSeenAt: new Date(), version: '2.5.48', capabilities: {},
      }]
      : [{
        agentKey: 'gateway', kind: 'access_gateway', enabled: true, status: 'online',
        lastSeenAt: new Date(), version: '2.5.48', capabilities: { remoteDoorControl: true },
      }],
  };
  return { service, state, enqueued, audits, snapshot, context };
}

test('mapLegacyCardRow 解析已隐藏前缀，不把整串当房号', () => {
  const visible = mapLegacyCardRow(rawRows[0] as never);
  assert.equal(visible.roomLabel, '228/50/202');
  assert.equal(visible.hidden, false);
  assert.equal(visible.status, '在用');
  assert.equal(visible.id, 12026);
  assert.equal(visible.wgCardNo, icToWg('B9F7D803'));
  assert.equal(visible.fieldsIncomplete, false);

  const hidden = mapLegacyCardRow(rawRows[4] as never);
  assert.equal(hidden.roomLabel, '228/50/202');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.status, '已隐藏');
  assert.equal(hidden.sequence, 4);
  assert.equal(hidden.id, 5633);
});

test('旧助手缺 personName/时间字段：房号兜底、hidden=null、fieldsIncomplete=true', () => {
  const oldRow = mapLegacyCardRow({
    personId: 26412,
    personNo: '11296',
    sequence: 8,
    icCardNo: 'B9F7D803',
    issuedAt: '2026-11-09T14:58:19',
    personName: null,
    cardInfoId: null,
    personCreatedAt: null,
    lastSwipeAt: null,
    lastDevice: null,
  } as never, 1, '228/50/202');
  assert.equal(oldRow.roomLabel, '228/50/202');
  assert.equal(oldRow.hidden, null);
  assert.equal(oldRow.status, '在用');
  assert.equal(oldRow.fieldsIncomplete, true);
  assert.equal(oldRow.wgCardNo, '21663417');
});

test('cards/history 旧助手返回时用请求地址兜底 roomLabel', async () => {
  const { service, state } = makeService();
  const oldSnapshot = {
    ...snapshot,
    history: [{
      personId: 26412,
      personNo: '11296',
      sequence: 8,
      icCardNo: 'B9F7D803',
      issuedAt: '2026-11-09T14:58:19',
      personName: null,
      cardInfoId: null,
      personCreatedAt: null,
      lastSwipeAt: null,
      lastDevice: null,
    }],
  };
  state.legacySnapshotRepo.findOne = async () => oldSnapshot;
  state.requestLegacyHistory = async () => oldSnapshot;
  state.waitLegacyHistory = async () => oldSnapshot;
  const result = await service.getLegacyCardHistory(2, '228/50/202', undefined, user, scopeAll);
  assert.equal((result as any).fieldsIncomplete, true);
  assert.equal((result as any).rows[0].roomLabel, '228/50/202');
  assert.equal((result as any).rows[0].hidden, null);
  assert.equal((result as any).rows[0].status, '在用');
});

test('cards/history 返回 228/50/202 的 8 条捷顺发卡记录', async () => {
  const { service } = makeService();
  const result = await service.getLegacyCardHistory(2, '228/50/202', undefined, user, scopeAll);
  assert.equal((result as any).status, 'ready');
  assert.equal((result as any).rows.length, 8);
  assert.equal((result as any).rows.filter((row: any) => row.hidden).length, 4);
  assert.equal((result as any).rows[0].personNo, '11296');
  assert.equal((result as any).rows[0].roomLabel, '228/50/202');
  // 该户所属楼栋（50 号楼）在 .88 的门禁系统，供发卡页默认选择。
  assert.equal((result as any).rows[0].accessSystem, 'iccard');
});

test('cards/history phase1 房号的行 accessSystem=null', async () => {
  const { service, state } = makeService();
  state.resolveLegacyRoomByInput = async () => ({
    community: { id: 1, name: '枫桦景苑一期' },
    building: { id: 5, lane: '198', buildingNo: '1' },
    house: { id: 9, roomNo: '101' },
    roomKey: '198/1/101',
    legacyStorageRoomKey: '198/01/101',
  });
  const result = await service.getLegacyCardHistory(1, '198/1/101', undefined, user, scopeAll);
  assert.equal((result as any).rows.length > 0, true);
  assert.ok((result as any).rows.every((row: any) => row.accessSystem === null));
});

test('apply-mdb 按系统入队；房号不属于该系统时明确失败', async () => {
  const { service, enqueued, audits } = makeService();
  const result = await service.applyLegacyCardMdb(12026, { systems: ['iccard', 'mjsystem'] }, user, scopeAll);
  assert.equal((result as any).results.length, 2);
  const iccard = (result as any).results.find((row: any) => row.system === 'iccard');
  const mjsystem = (result as any).results.find((row: any) => row.system === 'mjsystem');
  assert.equal(iccard.status, 'queued');
  assert.equal(mjsystem.status, 'failed');
  assert.match(mjsystem.error, /门禁系统/);
  assert.equal(enqueued.length, 1);
  assert.equal((enqueued[0] as any).operation, 'access_database_only');
  assert.equal(audits.length, 1);
});

test('apply-mdb 不传 systems 时默认写本楼栋系统（iccard / mjsystem 各一例）', async () => {
  // 50 号楼 = iCCard；不传 systems 时默认按本楼栋系统入队。
  const iccard = makeService();
  const iccardResult: any = await iccard.service.applyLegacyCardMdb(12026, {} as never, user, scopeAll);
  assert.deepEqual(iccardResult.results.map((row: any) => row.system), ['iccard']);
  assert.equal(iccardResult.results[0].status, 'queued');
  assert.equal(iccardResult.taskIds.length, 1);
  assert.equal((iccard.enqueued[0] as any).targetBuildings[0].accessSystem, 'iccard');
  assert.equal((iccard.enqueued[0] as any).targetBuildings[0].buildingNo, '50');
  assert.deepEqual((iccard.audits[0] as any).args[3].systems, ['iccard']);

  // 26 号楼 = MjSystem；传空数组也走默认。
  const mjsystem = makeService();
  mjsystem.state.resolveLegacyCardRoom = async () => ({
    ...mjsystem.context,
    building: { ...mjsystem.context.building, buildingNo: '26' },
  });
  const mjResult: any = await mjsystem.service.applyLegacyCardMdb(12026, { systems: [] } as never, user, scopeAll);
  assert.deepEqual(mjResult.results.map((row: any) => row.system), ['mjsystem']);
  assert.equal(mjResult.results[0].status, 'queued');
  assert.equal((mjsystem.enqueued[0] as any).targetBuildings[0].accessSystem, 'mjsystem');
});

test('apply-mdb 未传 systems 且本楼栋未配置门禁路由时明确 400', async () => {
  const { service, state, context } = makeService();
  state.resolveLegacyCardRoom = async () => ({
    ...context,
    building: { ...context.building, buildingNo: '99' },
  });
  await assert.rejects(
    service.applyLegacyCardMdb(12026, {} as never, user, scopeAll),
    /门禁路由尚未配置/,
  );
});

test('grant-boards 多主板部分失败不影响其他主板', async () => {
  const { service, enqueued } = makeService();
  const result = await service.grantLegacyCardBoards(12026, {
    buildingNos: ['50', '41', '26'],
    mode: 'add',
  }, user, scopeAll);
  const rows = (result as any).results;
  assert.equal(rows.find((row: any) => row.buildingNo === '50').status, 'ok');
  assert.equal(rows.find((row: any) => row.buildingNo === '41').status, 'failed');
  assert.equal(rows.find((row: any) => row.buildingNo === '26').status, 'ok');
  assert.equal(enqueued.length, 3);
  assert.deepEqual(enqueued.map((row: any) => row.operation), ['controller_upload', 'controller_upload', 'controller_upload']);
});

test('grant-boards remove 使用 controller_revoke', async () => {
  const { service, enqueued } = makeService();
  const result = await service.grantLegacyCardBoards(12026, {
    buildingNos: ['50'],
    mode: 'remove',
  }, user, scopeAll);
  assert.equal((result as any).results[0].status, 'ok');
  assert.equal((enqueued[0] as any).operation, 'controller_revoke');
});

test('grant-boards 网关离线时返回 offline 而不是 failed', async () => {
  const { service, state } = makeService();
  state.agentRepo = { find: async () => [] };
  const result = await service.grantLegacyCardBoards(12026, {
    buildingNos: ['50', '41'],
    mode: 'add',
  }, user, scopeAll);
  assert.deepEqual((result as any).results.map((row: any) => row.status), ['offline', 'offline']);
});

test('单卡详情聚合已写入系统和已授权楼栋', async () => {
  const { service, state, snapshot: source } = makeService();
  const wg = icToWg('B9F7D803');
  source.permissions = [
    { wgCardNo: wg, accessSystem: 'iccard', buildingNo: '50', controller: '50号大门', door: '50号大门', sourceTable: 't_d_Privilege' },
  ];
  state.authorizationRepo.find = async () => [{
    id: 1,
    operation: 'controller_upload',
    status: 'completed',
    targetBuildings: [{ id: 41, buildingNo: '41', accessSystem: 'iccard' }],
    createdAt: new Date(),
  }];
  const result = await service.getLegacyCard(12026, user, scopeAll);
  assert.deepEqual((result as any).appliedSystems, ['iccard']);
  assert.deepEqual((result as any).grantedBuildings, ['41', '50']);
});

/** grant-options 依赖设备管理（listDoorControllers）的 phase2 路由，单独搭一套 fake repo。 */
function makeGrantOptionsService() {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, any>;
  const communities = [
    { id: 2, name: '枫桦景苑二期', enabled: true },
    { id: 229, name: '枫桦景苑二期B', enabled: true },
    { id: 1, name: '枫桦景苑一期', enabled: true },
  ];
  const buildings = [
    { id: 11, communityId: 2, lane: '228', buildingNo: '11' },
    // 同一楼栋号重复记录：授权选项要按 buildingNo 去重。
    { id: 111, communityId: 2, lane: '228', buildingNo: '11' },
    { id: 9, communityId: 2, lane: '228', buildingNo: '9' },
    { id: 26, communityId: 2, lane: '228', buildingNo: '26' },
    // 不在二期联网门禁路由里：不能出现在授权选项。
    { id: 99, communityId: 2, lane: '228', buildingNo: '99' },
    // 另一个二期小区：不能串到这张卡的候选里。
    { id: 31, communityId: 229, lane: '228', buildingNo: '31' },
  ];
  state.requireTenant = () => 3;
  state.findLegacyCardById = async () => ({ row: { personName: '228/11/101/1', icCardNo: 'B9F7D803' }, snapshot: {} });
  state.resolveLegacyCardRoom = async () => ({
    community: communities[0],
    building: buildings[0],
    house: { id: 7, buildingId: 11, roomNo: '101' },
    roomKey: '228/11/101',
    legacyStorageRoomKey: '228/11/101',
  });
  state.communityRepo = {
    find: async () => communities,
    findOne: async ({ where }: { where: { id: number } }) => communities.find((item) => item.id === where.id) ?? null,
  };
  state.buildingRepo = {
    find: async ({ where }: { where: { communityId?: { _value?: number[]; value?: number[] } } }) => {
      const ids = where?.communityId?._value ?? where?.communityId?.value ?? [];
      return buildings.filter((building) => !ids.length || ids.includes(building.communityId));
    },
  };
  state.agentRepo = {
    find: async ({ where }: { where: { kind: string } }) => where.kind === 'access_gateway'
      ? [{ agentKey: 'gateway', kind: 'access_gateway', enabled: true, status: 'online', lastSeenAt: new Date(), version: '2.5.48', capabilities: { remoteDoorControl: true } }]
      : [{ agentKey: 'legacy', kind: 'legacy_sync', enabled: true, status: 'online', lastSeenAt: new Date(), version: '2.5.48', capabilities: {} }],
  };
  state.authorizationRepo = {
    find: async () => [],
    findOne: async () => null,
    manager: { getRepository: () => ({ create: (value: unknown) => value, save: async (value: unknown) => value }) },
  };
  return { service, state };
}

test('cards/:id/grant-options：只返回该卡所在小区二期路由门栋（去重+自然排序）并带本楼栋', async () => {
  const { service } = makeGrantOptionsService();
  const result: any = await service.getLegacyCardGrantOptions(12026, user, scopeAll);
  assert.equal(result.communityId, 2);
  assert.equal(result.houseId, 7);
  assert.equal(result.homeBuildingNo, '11');
  assert.equal(result.accessSystem, 'iccard');
  // 9/11/26 在二期路由内；重复的 11 去重；99 无路由、229 小区楼栋不串入。
  assert.deepEqual(result.options.map((option: any) => option.buildingNo), ['9', '11', '26']);
  assert.deepEqual(result.options.map((option: any) => option.accessSystem), ['mjsystem', 'iccard', 'mjsystem']);
  assert.ok(result.options.every((option: any) => typeof option.doorName === 'string' && option.doorName.length > 0));
});

test('cards/:id/grant-options：一期卡 options 为空、accessSystem=null、本楼栋仍返回', async () => {
  const { service, state } = makeGrantOptionsService();
  state.resolveLegacyCardRoom = async () => ({
    community: { id: 1, name: '枫桦景苑一期' },
    building: { id: 5, communityId: 1, lane: '198', buildingNo: '1' },
    house: { id: 9, buildingId: 5, roomNo: '101' },
    roomKey: '198/1/101',
    legacyStorageRoomKey: '198/01/101',
  });
  const result: any = await service.getLegacyCardGrantOptions(12026, user, scopeAll);
  assert.equal(result.communityId, 1);
  assert.equal(result.homeBuildingNo, '1');
  assert.equal(result.accessSystem, null);
  assert.deepEqual(result.options, []);
});

test('cards/:id/grant-options：卡不在数据范围 403', async () => {
  const { service, state } = makeGrantOptionsService();
  // 用真实 resolveLegacyCardRoom 校验数据范围（二期账号 scope 不含这张卡所在小区）。
  delete state.resolveLegacyCardRoom;
  state.buildingRepo = {
    find: async () => [{ id: 11, communityId: 2, lane: '228', buildingNo: '11' }],
  };
  state.communityRepo = {
    findOne: async () => ({ id: 2, name: '枫桦景苑二期' }),
    find: async () => [],
  };
  state.houseRepo = { find: async () => [{ id: 7, buildingId: 11, roomNo: '101' }] };
  await assert.rejects(
    service.getLegacyCardGrantOptions(12026, user, { scopeAll: false, communityIds: [16] } as never),
    /管理范围/,
  );
});