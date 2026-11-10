import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { icToWg } from './access-card-routing';

const user = { id: 7, tenantId: 3 } as never;
const scopeAll = { scopeAll: true } as never;
const toIso = (milliseconds: number) => new Date(milliseconds).toISOString();

/** 30 行捷顺最近发卡记录：同名房号不同序号，全部能匹配到 PMS 228/50/202。 */
const rawRows = Array.from({ length: 30 }, (_, index) => {
  const sequence = 30 - index;
  return {
    personId: 26412 - index,
    personNo: String(11296 - index),
    sequence,
    icCardNo: (0xb9f7d800 + index).toString(16).toUpperCase(),
    issuedAt: toIso(1794207499000 - index * 60_000),
    personName: `228/50/202/${sequence}`,
    cardInfoId: 12026 - index,
    personCreatedAt: toIso(1794207426000),
    lastSwipeAt: null,
    lastDevice: null,
  };
});

const legacyAgent = {
  agentKey: 'legacy', kind: 'legacy_sync', enabled: true, status: 'online',
  lastSeenAt: new Date(), version: '2.5.48', capabilities: {},
};
const building = { id: 119, tenantId: 3, communityId: 2, lane: '228', buildingNo: '50' };
const house = { id: 1435, tenantId: 3, buildingId: 119, roomNo: '202' };
const community = { id: 2, tenantId: 3, name: '枫桦景苑二期' };

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tenantId: 3,
    roomKey: '__recent_js_cards__',
    status: 'ready',
    history: rawRows.map((row) => ({ ...row })),
    issuedCount: 30,
    nextSequence: 31,
    requestedAt: new Date(Date.now() - 5_000),
    refreshedAt: new Date(Date.now() - 5_000),
    leaseAgentKey: null,
    leaseExpiresAt: null,
    lastError: null,
    permissionStatus: 'ready',
    permissionSubjects: [],
    permissions: [],
    permissionRequestedAt: null,
    permissionRefreshedAt: null,
    permissionLeaseAgentKey: null,
    permissionLeaseExpiresAt: null,
    permissionLastError: null,
    ...overrides,
  } as any;
}

function makeService(initial: any) {
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  const state = service as unknown as Record<string, any>;
  let current = initial;
  const saves: Array<Record<string, any>> = [];
  state.requireTenant = () => 3;
  state.legacySnapshotRepo = {
    findOne: async () => current,
    create: (value: unknown) => value,
    save: async (value: Record<string, any>) => {
      current = value;
      saves.push(value);
      return value;
    },
  };
  state.buildingRepo = { find: async () => [building] };
  state.houseRepo = { find: async () => [house] };
  state.communityRepo = { find: async () => [community] };
  state.authorizationRepo = { find: async () => [] };
  state.agentRepo = {
    find: async ({ where }: { where: { kind: string } }) =>
      (where.kind === 'legacy_sync' ? [legacyAgent] : []),
  };
  // 统计入队次数：任何“无快照/过期/error 重试”路径都必须恰好入队一次。
  let requestCalls = 0;
  const realRequest = state.requestRecentLegacySnapshot;
  state.requestRecentLegacySnapshot = async (...args: unknown[]) => {
    requestCalls += 1;
    return realRequest.apply(service, args);
  };
  let waitCalls = 0;
  const realWait = state.waitLegacyRecent;
  state.waitLegacyRecent = async (...args: unknown[]) => {
    waitCalls += 1;
    return realWait.apply(service, args);
  };
  return {
    service,
    state,
    saves,
    current: () => current,
    requestCalls: () => requestCalls,
    waitCalls: () => waitCalls,
  };
}

test('cards/recent：ready 快照连续两次 GET 都返回 ready+30 行，不重置快照', async () => {
  const snapshot = makeSnapshot();
  const { service, saves, requestCalls, current } = makeService(snapshot);
  const first = await service.getLegacyCardRecent(user, scopeAll);
  const second = await service.getLegacyCardRecent(user, scopeAll);
  for (const result of [first, second]) {
    assert.equal(result.status, 'ready');
    assert.equal(result.rows.length, 30);
    assert.equal(result.refreshing, false);
    assert.equal(result.fieldsIncomplete, false);
  }
  // GET 绝不能在 ready 时无条件入队/清空 history。
  assert.equal(requestCalls(), 0);
  assert.equal(saves.length, 0);
  assert.equal(current().status, 'ready');
});

test('cards/recent：无快照时入队并等待助手回传 ready', async () => {
  const ready = makeSnapshot();
  const { service, state, requestCalls } = makeService(null);
  state.waitLegacyRecent = async () => ready;
  const result = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(requestCalls(), 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 30);
  assert.equal(result.refreshing, false);
});

test('cards/recent：pending 时轮询到助手回传 ready（不重复入队）', async () => {
  const pending = makeSnapshot({ status: 'pending', history: [], requestedAt: new Date() });
  const ready = makeSnapshot();
  const { service, state, requestCalls } = makeService(pending);
  state.sleepLegacyRecentPoll = async () => undefined;
  let finds = 0;
  state.legacySnapshotRepo.findOne = async () => {
    finds += 1;
    return finds === 1 ? pending : ready;
  };
  const result = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(requestCalls(), 0);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 30);
});

test('cards/recent：等待超时返回 pending 且保留上一次 rows', async () => {
  const pending = makeSnapshot({ status: 'pending', requestedAt: new Date() });
  const { service, state, requestCalls } = makeService(pending);
  // 真实等待会轮询 8s；这里直接模拟“等到超时也没回传”。
  state.waitLegacyRecent = async (snapshot: Record<string, any>) => snapshot;
  const result = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(requestCalls(), 0);
  assert.equal(result.status, 'pending');
  assert.equal(result.refreshing, true);
  assert.equal(result.rows.length, 30);
  assert.equal((result.rows[0] as any).roomLabel, '228/50/202');
});

test('cards/recent：error 30s 内直接返回错误，不重复入队等待', async () => {
  const errorSnapshot = makeSnapshot({
    status: 'error',
    lastError: '捷顺数据库连接超时',
    requestedAt: new Date(Date.now() - 5_000),
  });
  const { service, requestCalls, waitCalls } = makeService(errorSnapshot);
  const result = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(result.status, 'error');
  assert.equal(result.error, '捷顺数据库连接超时');
  assert.equal(result.refreshing, false);
  // 上一次成功回传的行仍可展示，不因 error 清空。
  assert.equal(result.rows.length, 30);
  assert.equal(requestCalls(), 0);
  assert.equal(waitCalls(), 0);
});

test('cards/recent：error 超过 30s 后重新入队并等待', async () => {
  const errorSnapshot = makeSnapshot({
    status: 'error',
    lastError: '捷顺数据库连接超时',
    requestedAt: new Date(Date.now() - 31_000),
  });
  const ready = makeSnapshot();
  const { service, state, requestCalls } = makeService(errorSnapshot);
  state.waitLegacyRecent = async () => ready;
  const result = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(requestCalls(), 1);
  assert.equal(result.status, 'ready');
});

test('cards/recent：行补齐 communityName/lane/roomNo/houseId，roomLabel 不丢', async () => {
  const { service } = makeService(makeSnapshot());
  const result = await service.getLegacyCardRecent(user, scopeAll);
  const row = result.rows[0] as any;
  assert.equal(row.roomLabel, '228/50/202');
  assert.equal(row.hidden, false);
  assert.equal(row.status, '在用');
  assert.equal(row.personId, 26412);
  assert.equal(row.personNo, '11296');
  assert.equal(row.id, 12026);
  // 页面「查看该户历史」跳转依赖的匹配字段。
  assert.equal(row.communityId, 2);
  assert.equal(row.communityName, '枫桦景苑二期');
  assert.equal(row.buildingId, 119);
  assert.equal(row.lane, '228');
  assert.equal(row.buildingNo, '50');
  assert.equal(row.roomNo, '202');
  assert.equal(row.houseId, 1435);
  assert.equal(row.roomKey, '228/50/202');
  assert.equal(row.projectPhase, 'phase2');
  // 发卡页「添加到二期门禁系统」按行就能拿到本楼栋系统/楼栋号，不用再猜。
  assert.equal(row.accessSystem, 'iccard');
  assert.equal(row.homeBuildingNo, '50');
  assert.equal(row.wgCardNo, icToWg('B9F7D800'));
  assert.equal(row.canManageAccess, true);
  // 既有前端字段不能丢。
  for (const key of ['personName', 'actionMessage', 'accessDatabaseTask', 'controllerTask', 'fieldsIncomplete']) {
    assert.ok(key in row, `缺少行字段 ${key}`);
  }
});

test('POST queries：显式刷新入队并等待 ready', async () => {
  const { service, state, requestCalls } = makeService(makeSnapshot());
  // 入队会就地复用/改写入队前的快照对象，回传结果用独立的新快照模拟。
  state.waitLegacyRecent = async () => makeSnapshot();
  const result = await service.requestRecentLegacyCards(user, scopeAll);
  assert.equal(requestCalls(), 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 30);
});

test('POST queries：已在 pending 时不重复重置 requestedAt，只等待回传', async () => {
  const requestedAt = new Date(Date.now() - 1_000);
  const pending = makeSnapshot({ status: 'pending', requestedAt });
  const { service, state, requestCalls, saves } = makeService(pending);
  state.waitLegacyRecent = async (snapshot: Record<string, any>) => {
    assert.equal(snapshot.requestedAt, requestedAt);
    return makeSnapshot();
  };
  const result = await service.requestRecentLegacyCards(user, scopeAll);
  assert.equal(requestCalls(), 1);
  assert.equal(saves.length, 0);
  assert.equal(result.status, 'ready');
});

test('GET queries：轮询不重置 ready 快照，过期才入队且刷新期间保留旧 rows', async () => {
  const ready = makeSnapshot();
  const first = makeService(ready);
  const result = await first.service.getRecentLegacyCards(user, scopeAll);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 30);
  assert.equal(first.requestCalls(), 0);
  assert.equal(first.saves.length, 0);

  const stale = makeSnapshot({ refreshedAt: new Date(Date.now() - 61_000) });
  const second = makeService(stale);
  const staleResult = await second.service.getRecentLegacyCards(user, scopeAll);
  assert.equal(second.requestCalls(), 1);
  assert.equal(staleResult.status, 'pending');
  assert.equal(staleResult.refreshing, true);
  assert.equal(staleResult.rows.length, 30);
});

test('cards/recent 行级聚合：appliedSystems/grantedBuildings/latestTaskAt 一次批量查询，revoke 扣减、空卡为空', async () => {
  const snapshot = makeSnapshot();
  snapshot.history[0] = { ...snapshot.history[0], icCardNo: '11223344' };
  snapshot.history[1] = { ...snapshot.history[1], icCardNo: '55667788' };
  snapshot.history[2] = { ...snapshot.history[2], icCardNo: null };
  const { service, state } = makeService(snapshot);
  const wg0 = icToWg('11223344');
  const wg1 = icToWg('55667788');
  const at = (iso: string) => new Date(iso);
  const task = (over: Record<string, unknown>) => ({
    id: 1,
    wgCardNo: wg0,
    operation: 'controller_upload',
    status: 'completed',
    createdAt: at('2026-10-01T00:00:00Z'),
    requestedAt: at('2026-10-01T00:00:00Z'),
    completedAt: at('2026-10-01T00:01:00Z'),
    targetBuildings: [],
    controllerResults: [],
    ...over,
  });
  let findCalls = 0;
  state.authorizationRepo = {
    find: async () => {
      findCalls += 1;
      return [
        task({ id: 1, targetBuildings: [{ buildingId: 41, buildingNo: '41', accessSystem: 'iccard' }] }),
        task({
          id: 2,
          wgCardNo: wg1,
          createdAt: at('2026-10-02T00:00:00Z'),
          requestedAt: at('2026-10-02T00:00:00Z'),
          completedAt: at('2026-10-02T02:00:00Z'),
          targetBuildings: [
            { buildingId: 41, buildingNo: '41', accessSystem: 'iccard' },
            { buildingId: 50, buildingNo: '50', accessSystem: 'iccard' },
          ],
        }),
        task({
          id: 3,
          operation: 'controller_revoke',
          createdAt: at('2026-10-03T00:00:00Z'),
          requestedAt: at('2026-10-03T00:00:00Z'),
          completedAt: at('2026-10-03T01:00:00Z'),
          targetBuildings: [{ buildingId: 41, buildingNo: '41', accessSystem: 'iccard' }],
        }),
      ];
    },
  };
  const result: any = await service.getLegacyCardRecent(user, scopeAll);
  assert.equal(findCalls, 1, '必须一次批量查询，禁止按卡 N+1');
  assert.deepEqual(result.rows[0].appliedSystems, ['iccard']);
  assert.deepEqual(result.rows[0].grantedBuildings, []);
  assert.equal(result.rows[0].latestTaskAt, '2026-10-03T01:00:00.000Z');
  assert.deepEqual(result.rows[1].appliedSystems, ['iccard']);
  assert.deepEqual(result.rows[1].grantedBuildings, ['41', '50']);
  assert.equal(result.rows[1].latestTaskAt, '2026-10-02T02:00:00.000Z');
  assert.deepEqual(result.rows[2].appliedSystems, []);
  assert.deepEqual(result.rows[2].grantedBuildings, []);
  assert.equal(result.rows[2].latestTaskAt, null);
});