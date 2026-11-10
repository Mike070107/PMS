// Synthetic-only transport for the access-card issuance / devices regression fixture.
// Every unexpected call fails closed: this fixture never reaches a real server or device.
const w = window as any;
w.__calls = [];
w.__scenario = 'normal';
w.__recentMode = 'ready';
w.__recentCalls = 0;
w.__grantMode = 'success';
w.__appliedIds = new Set<number>();
w.__grantDone = false;
w.__lastGrantBuildings = [];
w.__grantPolls = {};
w.__verifyCalls = 0;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const COMMUNITIES = [
  {
    id: 1, name: '枫桦景苑一期', mainLane: '198', isGroup: false,
    buildings: [{
      id: 11, communityId: 1, lane: '198', buildingNo: '6', roadName: '枫桦路',
      houses: [{ id: 111, buildingId: 11, roomNo: '502', ownerName: null, ownerPhone: null, owners: [] }],
    }],
  },
  {
    id: 2, name: '枫桦景苑二期', mainLane: '228', isGroup: false,
    buildings: [{
      id: 21, communityId: 2, lane: '228', buildingNo: '3', roadName: '枫桦路',
      houses: [{ id: 211, buildingId: 21, roomNo: '502', ownerName: null, ownerPhone: null, owners: [] }],
    }],
  },
];

// 生产现场 readiness 的真实形态：三个在线 agent（都不是 issuer），features 决定各项能力。
const AGENTS = [
  { id: 'agent-access-gateway', kind: 'access_gateway', name: '门禁网关', version: '2.5.50', status: 'online', capabilities: { remoteDoorControl: true }, lastSeenAt: '2026-11-09T12:00:00+08:00' },
  { id: 'agent-legacy-sync', kind: 'legacy_sync', name: '.80 数据同步', version: '2.5.50', status: 'online', capabilities: {}, lastSeenAt: '2026-11-09T12:00:00+08:00' },
  { id: 'agent-parking-gateway', kind: 'parking_gateway', name: '停车网关', version: '2.5.50', status: 'online', capabilities: {}, lastSeenAt: '2026-11-09T12:00:00+08:00' },
];
const FEATURES = {
  cardWrite: false, legacyDbWrite: true, accessDbWrite: true,
  parkingDbRead: true, parkingDbWrite: false, controllerUpload: true,
};
const READINESS_NORMAL = {
  simulationEnabled: false,
  features: FEATURES,
  agents: AGENTS,
  doorControlCommunities: [{ id: 2, name: '枫桦景苑二期' }],
  doorControlBuildings: [],
};
const READINESS_NO_DOOR = { ...READINESS_NORMAL, doorControlCommunities: [] };

const DOOR_CONTROLLERS = {
  agentOnline: true, // 与小区是否二期解耦后的真实网关状态
  gatewayVersion: '2.5.50',
  checkedAt: '2026-11-09T12:00:00+08:00',
  controllers: [
    { communityId: 2, communityName: '枫桦景苑二期', controllerId: 61, buildingNo: '6', doorNo: 1, doorName: '6号大门', controllerName: '6号楼控制器', accessSystem: 'iccard', routeReady: true, status: 'online', supportRemoteOpen: true, supportTemporaryOpen: true, lastOperation: null, lastCheckedAt: '2026-11-09T12:00:00+08:00', lastError: null },
    { communityId: 2, communityName: '枫桦景苑二期', controllerId: 71, buildingNo: '7', doorNo: 1, doorName: '7号大门', controllerName: '7号楼控制器', accessSystem: 'iccard', routeReady: true, status: 'online', supportRemoteOpen: true, supportTemporaryOpen: true, lastOperation: null, lastCheckedAt: '2026-11-09T12:00:00+08:00', lastError: null },
  ],
  message: '当前小区控制器回执来自上次检查，可点「重新检查在线状态」刷新。',
};

const RECENT_PENDING_ROW = {
  id: 900, personNo: 'P0009', personName: null, sequence: 1, roomLabel: '198/6/502',
  icCardNo: 'OLD00001', wgCardNo: null, issuedAt: '2026-11-08T09:00:00+08:00',
  hidden: false, status: '在用', communityId: 1, communityName: '枫桦景苑一期', lane: '198',
  buildingId: 11, buildingNo: '6', houseId: 111, roomNo: '502', roomKey: '198/6/502',
  personCreatedAt: null, lastSwipeAt: null, lastDevice: null, accessSystem: 'iccard', homeBuildingNo: '6',
  // 行本身没有标记，由接口级 fieldsIncomplete=true 兜底（旧助手快照未回传字段）。
  fieldsIncomplete: false,
};
// 最近 30 笔：最新在前（id 1 最新），页面第 1 页显示序号 1..10。
const RECENT_READY_ROWS = Array.from({ length: 30 }, (_, index) => {
  // id 2（index 1）模拟行级 fieldsIncomplete=true：助手仍未回传字段，空列要继续提示升级；
  // 其余行字段已回传，lastSwipeAt/lastDevice 为空只是新卡在 .80 捷顺库没有刷卡记录。
  const incomplete = index === 1;
  const hasSwipe = !incomplete && index % 3 === 0;
  const hasPersonCreatedAt = !incomplete && index % 2 === 0;
  return {
    id: index + 1,
    personNo: `P${String(index + 1).padStart(4, '0')}`,
    personName: `合成${index + 1}`,
    sequence: index + 1,
    roomLabel: '228/6/502',
    icCardNo: `NEWA${String(index + 1).padStart(4, '0')}`,
    wgCardNo: `00A1B2${String(index + 1).padStart(2, '0')}`,
    issuedAt: `2026-11-${String(9 - Math.floor(index / 10)).padStart(2, '0')}T${String(20 - (index % 10)).padStart(2, '0')}:00:00+08:00`,
    hidden: false, status: '在用', communityId: 2, communityName: '枫桦景苑二期', lane: '228',
    buildingId: 21, buildingNo: '3', houseId: 211, roomNo: '502', roomKey: '228/6/502',
    personCreatedAt: hasPersonCreatedAt ? `2026-10-${String(30 - index).padStart(2, '0')}T08:00:00+08:00` : null,
    lastSwipeAt: hasSwipe ? `2026-11-0${1 + (index % 8)}T09:00:00+08:00` : null,
    lastDevice: hasSwipe ? '228弄3号大门' : null,
    accessSystem: 'iccard', homeBuildingNo: '6',
    appliedSystems: index === 0 ? ['iccard'] : null,
    ownerName: null, ownerPhone: null, ownerId: null, fieldsIncomplete: incomplete,
  };
});
const RECENT_REFRESHED_AT = '2026-11-09T12:30:00+08:00';

// 发卡历史 30 条：personCreatedAt 递增 → 倒序后第 1 页序号应为 30..21。
// 第 1 页混三种情况：index 29 有 2020 年 .80 刷卡记录；index 28 行级 fieldsIncomplete=true；
// index 27 字段已回传但 .80 无刷卡记录（新卡），应显示 — 而不是升级提示。
const HISTORY_ROWS = Array.from({ length: 30 }, (_, index) => {
  const incomplete = index === 28;
  const hasSwipe = index === 29;
  return {
    id: 101 + index,
    personNo: `109${String(index + 1).padStart(2, '0')}`,
    sequence: index + 1,
    roomLabel: '198/6/502',
    hidden: false,
    status: '在用',
    personCreatedAt: `2026-0${1 + Math.floor(index / 10)}-${String((index % 28) + 1).padStart(2, '0')}T08:00:00+08:00`,
    icCardNo: `0A1B2C${String(index + 1).padStart(2, '0')}`,
    wgCardNo: `1954${String(5700 + index)}`,
    issuedAt: `2026-0${1 + Math.floor(index / 10)}-${String((index % 28) + 1).padStart(2, '0')}T10:00:00+08:00`,
    lastSwipeAt: hasSwipe ? '2020-07-29T12:00:00+08:00' : null,
    lastDevice: hasSwipe ? '198弄6号大门' : null,
    fieldsIncomplete: incomplete,
    accessSystem: 'iccard',
    homeBuildingNo: '6',
    communityId: 1,
  };
});

const GRANT_OPTIONS = {
  communityId: 2,
  houseId: 211,
  homeBuildingNo: '6',
  accessSystem: 'iccard',
  options: [
    { buildingNo: '6', doorName: '6号大门', accessSystem: 'iccard' },
    { buildingNo: '7', doorName: '7号大门', accessSystem: 'iccard' },
    { buildingNo: '8', doorName: '8号大门', accessSystem: 'iccard' },
  ],
};

function cardDetail(id: number) {
  const applied = id === 1 || w.__appliedIds.has(id);
  const grantedBuildings = w.__grantDone ? w.__lastGrantBuildings : (id === 1 ? ['6'] : []);
  return {
    id,
    communityId: 2,
    homeBuildingNo: '6',
    accessSystem: 'iccard',
    appliedSystems: applied ? ['iccard'] : [],
    grantedBuildings,
    permissionCheckedAt: '2026-11-09T11:00:00+08:00',
    permissionSource: 'access_permission',
    grantedBuildingDetails: [
      { buildingNo: '6', granted: true, source: 't_d_Privilege' },
      { buildingNo: '7', granted: grantedBuildings.includes('7'), source: 't_d_Privilege' },
      { buildingNo: '8', granted: false, source: 't_d_Privilege' },
    ],
    latestTasks: [
      {
        id: 71, operation: 'controller_upload', status: 'completed',
        requestedAt: '2026-11-09T11:05:00+08:00', completedAt: '2026-11-09T11:05:08+08:00',
        targetBuildings: [{ buildingNo: '6', accessSystem: 'iccard' }, { buildingNo: '7', accessSystem: 'iccard' }],
        controllerResults: [
          { buildingNo: '6', status: 'success', acknowledgement: '主板回执 OK' },
          { buildingNo: '7', status: 'controller_failed', error: '控制器离线' },
        ],
        error: null, acknowledgement: null,
      },
      {
        id: 72, operation: 'access_database_only', status: 'completed',
        requestedAt: '2026-11-09T11:04:00+08:00', completedAt: '2026-11-09T11:04:02+08:00',
        targetBuildings: [], controllerResults: [], error: null, acknowledgement: null,
      },
      {
        id: 73, operation: 'controller_detect', status: 'failed',
        requestedAt: '2026-11-09T11:03:00+08:00', completedAt: '2026-11-09T11:03:20+08:00',
        targetBuildings: [{ buildingNo: '6' }], controllerResults: [], error: '网关未响应', acknowledgement: null,
      },
    ],
    icCardNo: `NEWA${String(id).padStart(4, '0')}`,
    roomLabel: '228/6/502',
  };
}

export async function request<T>(options: any): Promise<T> {
  const call = { url: options.url, method: options.method ?? 'GET', query: options.query ?? null, data: options.data ?? null, at: Date.now() };
  w.__calls.push(call);
  await pause(10);
  const scenario = w.__scenario;

  if (options.url === '/address-tree') return COMMUNITIES as T;
  if (options.url === '/access-card-issuance/readiness') {
    return (scenario === 'nodoor' ? READINESS_NO_DOOR : READINESS_NORMAL) as T;
  }
  if (options.url === '/access-card-issuance/door/controllers') {
    if (Number(options.query?.communityId) !== 2) {
      throw Error('远程门禁面板只能默认请求二期小区 communityId=2，实际 ' + String(options.query?.communityId));
    }
    return (scenario === 'nodoor' ? { ...DOOR_CONTROLLERS, controllers: [] } : DOOR_CONTROLLERS) as T;
  }
  if (options.url === '/access-card-issuance/cards/recent') {
    if (Number(options.query?.limit) !== 30) throw Error('最近做卡必须按 limit=30 查询');
    w.__recentCalls += 1;
    if (w.__recentMode === 'stall') {
      // 模拟助手迟迟不回传：每次查询都 pending，用尽自动重试后页面必须露出「重试」入口。
      await pause(200);
      return {
        status: 'pending', rows: [RECENT_PENDING_ROW], error: null,
        refreshedAt: '2026-11-09T12:00:00+08:00', fieldsIncomplete: true, refreshing: true,
      } as T;
    }
    if (w.__recentCalls === 1) {
      // 首次 pending + 旧行：页面应先显示旧行和「助手回传中…」，1.5s 后再取到 ready。
      // 接口级 fieldsIncomplete=true（旧助手快照）：行级没有标记也要提示升级。
      await pause(900);
      return {
        status: 'pending', rows: [RECENT_PENDING_ROW], error: null,
        refreshedAt: '2026-11-09T12:00:00+08:00', fieldsIncomplete: true, refreshing: true,
      } as T;
    }
    return {
      status: 'ready', rows: RECENT_READY_ROWS, error: null,
      refreshedAt: RECENT_REFRESHED_AT, fieldsIncomplete: false, refreshing: false,
    } as T;
  }
  if (options.url === '/access-card-issuance/cards/history') {
    return { status: 'ready', rows: HISTORY_ROWS, refreshedAt: RECENT_REFRESHED_AT, fieldsIncomplete: false } as T;
  }
  if (/^\/access-card-issuance\/cards\/\d+$/.test(options.url)) {
    return cardDetail(Number(options.url.split('/').pop())) as T;
  }
  if (/^\/access-card-issuance\/cards\/\d+\/grant-options$/.test(options.url)) {
    if (w.__grantFallback) throw Error('模拟旧后端没有 grant-options 接口');
    return GRANT_OPTIONS as T;
  }
  if (/^\/access-card-issuance\/cards\/\d+\/apply-mdb$/.test(options.url)) {
    const id = Number(options.url.split('/')[3]);
    w.__appliedIds.add(id);
    return { ok: true, systems: ['iccard'] } as T;
  }
  if (/^\/access-card-issuance\/cards\/\d+\/grant-boards$/.test(options.url)) {
    w.__lastGrantBuildings = Array.isArray(options.data?.buildingNos) ? options.data.buildingNos.map(String) : [];
    w.__grantDone = false;
    w.__grantPolls = {};
    return {
      taskIds: [71, 72],
      results: w.__lastGrantBuildings.map((buildingNo: string, index: number) => ({ buildingNo, status: 'ok', taskId: 71 + index })),
    } as T;
  }
  if (/^\/access-card-issuance\/cards\/\d+\/verify-grant$/.test(options.url)) {
    w.__verifyCalls += 1;
    return {
      checkedAt: '2026-11-09T12:00:00+08:00',
      grantedBuildings: ['6', '7'],
      message: '已读回 .88 门禁权限表：6、7 号楼',
    } as T;
  }
  if (/^\/access-card-issuance\/history-authorizations\/\d+$/.test(options.url)) {
    const taskId = Number(options.url.split('/').pop());
    w.__grantPolls[taskId] = (w.__grantPolls[taskId] ?? 0) + 1;
    const completedIds = [71, 72].filter((id) => (w.__grantPolls[id] ?? 0) >= 2);
    if (completedIds.length === 2) w.__grantDone = true;
    const firstPoll = w.__grantPolls[taskId] < 2;
    if (w.__grantMode === 'fail') {
      return {
        id: taskId, operation: 'controller_upload', status: 'failed',
        requestedAt: '2026-11-09T11:05:00+08:00', completedAt: '2026-11-09T11:05:05+08:00',
        targetBuildings: w.__lastGrantBuildings.map((buildingNo: string) => ({ buildingNo, accessSystem: 'iccard' })),
        controllerResults: w.__lastGrantBuildings.map((buildingNo: string) => ({ buildingNo, status: 'controller_failed', error: '控制器离线' })),
        error: '部分楼栋失败',
      } as T;
    }
    return {
      id: taskId, operation: 'controller_upload', status: firstPoll ? 'running' : 'completed',
      requestedAt: '2026-11-09T11:05:00+08:00', completedAt: firstPoll ? null : '2026-11-09T11:05:08+08:00',
      targetBuildings: w.__lastGrantBuildings.map((buildingNo: string) => ({ buildingNo, accessSystem: 'iccard' })),
      controllerResults: firstPoll ? [] : w.__lastGrantBuildings.map((buildingNo: string) => ({ buildingNo, status: 'success', acknowledgement: '主板回执 OK' })),
      error: null,
    } as T;
  }
  if (options.url === '/business/search') return { accessCards: [] } as T;
  throw Error('Unhandled synthetic request ' + String(options.url));
}

export const address = { tree: () => request<any[]>({ url: '/address-tree' }) };
export const accessCardIssuance = {
  readiness: () => request<any>({ url: '/access-card-issuance/readiness' }),
  createBatch: () => { throw Error('合成夹具不执行真实发卡'); },
  batch: () => { throw Error('合成夹具不执行真实发卡'); },
  retryAccessUpload: () => { throw Error('合成夹具不执行真实发卡'); },
};
