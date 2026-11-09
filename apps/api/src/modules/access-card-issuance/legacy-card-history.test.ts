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
