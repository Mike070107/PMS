// Synthetic-only transport for the access-card status regression fixture.
// Every unexpected call fails closed: this fixture never reaches a real server or device.
const w = window as any;
w.__calls = [];
w.__scenario = 'normal';
w.__recentMode = 'ready';
w.__recentCalls = 0;

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
  controllers: [],
  message: '当前小区控制器回执来自上次检查，可点「重新检查在线状态」刷新。',
};

const RECENT_PENDING_ROW = {
  id: 900, personNo: 'P0009', personName: null, sequence: 1, roomLabel: '198/6/502',
  icCardNo: 'OLD00001', wgCardNo: null, issuedAt: '2026-11-08T09:00:00+08:00',
  hidden: false, status: '在用', communityId: 1, communityName: '枫桦景苑一期', lane: '198',
  buildingId: 11, buildingNo: '6', houseId: 111, roomNo: '502', roomKey: '198/6/502',
  fieldsIncomplete: false,
};
const RECENT_READY_ROWS = [
  {
    id: 1, personNo: 'P0001', personName: '合成甲', sequence: 1, roomLabel: '228/3/502',
    icCardNo: 'NEWA0001', wgCardNo: '00A1B2C3', issuedAt: '2026-11-09T10:00:00+08:00',
    hidden: false, status: '在用', communityId: 2, communityName: '枫桦景苑二期', lane: '228',
    buildingId: 21, buildingNo: '3', houseId: 211, roomNo: '502', roomKey: '228/3/502',
    ownerName: null, ownerPhone: null, ownerId: null, fieldsIncomplete: false,
  },
  {
    id: 2, personNo: 'P0002', personName: '合成乙', sequence: 2, roomLabel: '228/3/502',
    icCardNo: 'NEWA0002', wgCardNo: '00A1B2C4', issuedAt: '2026-11-09T11:00:00+08:00',
    hidden: false, status: '在用', communityId: 2, communityName: '枫桦景苑二期', lane: '228',
    buildingId: 21, buildingNo: '3', houseId: 211, roomNo: '502', roomKey: '228/3/502',
    ownerName: null, ownerPhone: null, ownerId: null, fieldsIncomplete: false,
  },
];
const RECENT_REFRESHED_AT = '2026-11-09T12:30:00+08:00';

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
    return DOOR_CONTROLLERS as T;
  }
  if (options.url === '/access-card-issuance/cards/recent') {
    if (Number(options.query?.limit) !== 30) throw Error('最近做卡必须按 limit=30 查询');
    w.__recentCalls += 1;
    if (w.__recentMode === 'stall') {
      // 模拟助手迟迟不回传：每次查询都 pending，用尽自动重试后页面必须露出「重试」入口。
      await pause(200);
      return {
        status: 'pending', rows: [RECENT_PENDING_ROW], error: null,
        refreshedAt: '2026-11-09T12:00:00+08:00', fieldsIncomplete: false, refreshing: true,
      } as T;
    }
    if (w.__recentCalls === 1) {
      // 首次 pending + 旧行：页面应先显示旧行和「助手回传中…」，1.5s 后再取到 ready。
      await pause(900);
      return {
        status: 'pending', rows: [RECENT_PENDING_ROW], error: null,
        refreshedAt: '2026-11-09T12:00:00+08:00', fieldsIncomplete: false, refreshing: true,
      } as T;
    }
    return {
      status: 'ready', rows: RECENT_READY_ROWS, error: null,
      refreshedAt: RECENT_REFRESHED_AT, fieldsIncomplete: false, refreshing: false,
    } as T;
  }
  if (options.url === '/access-card-issuance/cards/history') {
    return { status: 'ready', rows: [], refreshedAt: RECENT_REFRESHED_AT, fieldsIncomplete: false } as T;
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
