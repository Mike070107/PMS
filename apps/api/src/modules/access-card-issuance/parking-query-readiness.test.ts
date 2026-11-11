import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { AccessCardAgent } from '../../entities/access-card-agent.entity';
import { ParkingQuery } from '../../entities/parking-query.entity';
import { supportsStructuredParkingQueries } from './parking-query.util';

const user = { id: 7, tenantId: 91362 } as any;
const fullAccess = { scopeAll: true } as any;
const dates = { startDate: '2026-10-01', endDate: '2026-10-02' };
const vehicle = { term: '沪ATEST1', database: 'parking2' as const };

function agent(overrides: Partial<AccessCardAgent> = {}): AccessCardAgent {
  return { id: 1, tenantId: user.tenantId, agentKey: 'isolated-parking', name: '隔离网关',
    kind: 'parking_gateway', enabled: true, status: 'online', lastSeenAt: new Date(),
    version: '2.5.52', capabilities: { parkingDbRead: true }, ...overrides } as AccessCardAgent;
}

// Only repositories/external collaborators are simulated. Both readiness and all query
// decisions, parsing and queue responses execute the actual service implementation.
// No app bootstrap, network, MIS/SQL Server credentials or production configuration.
function harness(agents: AccessCardAgent[]) {
  const tasks: ParkingQuery[] = [];
  const agentFinds: any[] = [];
  const repo = {
    manager: { connection: { query: async (_sql: string, params: unknown[]) => {
      assert.deepEqual(params, [user.tenantId]);
      return [];
    } } },
    create: (value: any) => ({ ...value }),
    save: async (value: ParkingQuery) => {
      const task = { ...value, id: tasks.length + 1 };
      tasks.push(task);
      return task;
    },
    findOne: async ({ where }: any) => tasks.find((task) =>
      Object.entries(where).every(([key, value]) => (task as any)[key] === value)) ?? null,
  };
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  Object.assign(service, {
    agentRepo: { find: async ({ where }: any) => {
      agentFinds.push(where);
      assert.equal(where.tenantId, user.tenantId, 'agent discovery must remain tenant-scoped');
      return agents.filter((item) => Object.entries(where).every(([key, value]) => (item as any)[key] === value));
    } },
    parkingQueryRepo: repo,
    communityRepo: { find: async () => [] },
    config: { get: (key: string) => key === 'NODE_ENV' ? 'production' : undefined },
    deliyun: { status: async () => ({ configured: false }) },
  });
  return { service, tasks, agentFinds };
}

test('2.5.52 / AssemblyVersion 2.5.52.0 pass the actual service and preserve the structured query contract', async () => {
  for (const version of ['2.5.52', '2.5.52.0', '2.4.0', '0.8.0']) {
    assert.equal(supportsStructuredParkingQueries(version), true);
    const h = harness([agent({ version })]);
    const readiness = await h.service.readiness(user);
    assert.equal(readiness.features.parkingDbRead, true);
    assert.deepEqual(readiness.parkingQuery, { ready: true, reason: 'ready', message: null });
    const result = await h.service.createParkingQuery(vehicle, user);
    assert.equal(result.status, 'pending');
    assert.equal(result.term, vehicle.term);
    assert.equal(result.database, 'parking2');
    assert.equal(h.tasks.length, 1);
    assert.equal(h.tasks[0].tenantId, user.tenantId);
    assert.equal(h.tasks[0].queryKind, 'vehicle');
    assert.equal(h.tasks[0].createdBy, user.id);
    await assert.rejects(h.service.getParkingQuery(result.id, { ...user, tenantId: 2 }), /不存在/);
  }
});

const unavailable: Array<{ name: string; agents: () => AccessCardAgent[]; message: RegExp; upgrade?: boolean }> = [
  { name: 'missing registration', agents: () => [], message: /当前租户未注册停车网关/ },
  { name: 'disabled even with a fresh online heartbeat', agents: () => [agent({ enabled: false })], message: /停车网关已禁用/ },
  { name: 'heartbeat older than the unchanged 15s TTL', agents: () => [agent({ lastSeenAt: new Date(Date.now() - 16_000) })], message: /心跳已过期/ },
  { name: 'never received a heartbeat', agents: () => [agent({ lastSeenAt: null })], message: /尚未收到心跳/ },
  { name: 'explicit offline', agents: () => [agent({ status: 'offline' })], message: /停车网关当前离线/ },
  { name: 'degraded is not online', agents: () => [agent({ status: 'degraded' })], message: /停车网关状态异常/ },
  { name: 'no read capability', agents: () => [agent({ capabilities: {} })], message: /未上报停车数据库读取能力.*parkingDbRead/ },
  { name: 'false read capability', agents: () => [agent({ capabilities: { parkingDbRead: false } })], message: /未上报停车数据库读取能力/ },
  { name: 'truthy string is not a read capability', agents: () => [agent({ capabilities: { parkingDbRead: 'true' as any } })], message: /未上报停车数据库读取能力/ },
  { name: 'old structured protocol', agents: () => [agent({ version: '2.3.9' })], message: /版本 2\.3\.9.*升级.*2\.4\.0.*0\.8\.0/, upgrade: true },
  { name: 'unknown version fails closed', agents: () => [agent({ version: 'unknown' })], message: /版本 unknown.*升级.*2\.4\.0/, upgrade: true },
  { name: 'other tenant gateway cannot authorize a query', agents: () => [agent({ tenantId: user.tenantId + 1 })], message: /当前租户未注册停车网关/ },
  { name: 'another kind cannot authorize a query', agents: () => [agent({ kind: 'access_gateway' })], message: /当前租户未注册停车网关/ },
];

for (const scenario of unavailable) {
  test(`actual service explains ${scenario.name} without misdiagnosing 2.5.52`, async () => {
    const h = harness(scenario.agents());
    await assert.rejects(h.service.createParkingQuery(vehicle, user), (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      assert.match(error.message, scenario.message);
      if (!scenario.upgrade) assert.doesNotMatch(error.message, /升级|2\.4\.0|0\.8\.0/);
      return true;
    });
    assert.equal(h.tasks.length, 0, 'failed checks must not enqueue work');
  });
  test(`readiness agrees with actual vehicle-query rejection: ${scenario.name}`, async () => {
    const h = harness(scenario.agents());
    const readiness = await h.service.readiness(user);
    assert.equal(readiness.features.parkingDbRead, false);
    assert.equal(readiness.parkingQuery.ready, false);
    assert.notEqual(readiness.parkingQuery.reason, 'ready');
    assert.match(readiness.parkingQuery.message!, scenario.message);
    await assert.rejects(h.service.createParkingQuery(vehicle, user), (error: Error) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.message, readiness.parkingQuery.message);
      return true;
    });
    assert.equal(h.tasks.length, 0);
  });
}

test('duplicate registrations: a stale/disabled/old record cannot hide an eligible online replacement', async () => {
  const h = harness([
    agent({ id: 1, version: '2.3.0', lastSeenAt: new Date(Date.now() - 20_000) }),
    agent({ id: 2, enabled: false }),
    agent({ id: 3, capabilities: {} }),
    agent({ id: 4, agentKey: 'new-online', lastSeenAt: new Date(Date.now() - 1_000) }),
  ]);
  assert.equal((await h.service.readiness(user)).features.parkingDbRead, true);
  assert.equal((await h.service.createParkingQuery(vehicle, user)).status, 'pending');
});

test('offline newer version and online old version do not combine into one capable gateway', async () => {
  const h = harness([agent({ status: 'offline' }), agent({ id: 2, version: '2.3.9' })]);
  assert.equal((await h.service.readiness(user)).features.parkingDbRead, false);
  await assert.rejects(h.service.createParkingQuery(vehicle, user), /版本 2\.3\.9.*升级/);
  assert.equal(h.tasks.length, 0);
});

const specialized = [
  { name: 'movement', minimum: /2\.5\.27/, older: '2.5.26', create: (s: AccessCardIssuanceService) => s.createParkingMovementQuery({ plate: '沪ATEST1', ...dates }, user) },
  { name: 'fee report', minimum: /2\.5\.27/, older: '2.5.26', create: (s: AccessCardIssuanceService) => s.createParkingFeeReport(dates, user, fullAccess) },
  { name: 'fee detail', minimum: /2\.5\.28/, older: '2.5.27', create: (s: AccessCardIssuanceService) => s.createParkingFeeDetail({ ...dates, category: 'renewal', page: 1 }, user, fullAccess) },
  { name: 'identity list', minimum: /2\.5\.49/, older: '2.5.48', create: (s: AccessCardIssuanceService) => s.createParkingIdentityList('亲情车', user) },
];
for (const entry of specialized) {
  test(`${entry.name} shares accurate availability reasons but keeps its own protocol minimum`, async () => {
    const online = harness([agent()]);
    assert.equal((await entry.create(online.service)).status, 'pending');
    const expired = harness([agent({ lastSeenAt: new Date(Date.now() - 16_000) })]);
    await assert.rejects(entry.create(expired.service), (error: Error) => {
      assert.match(error.message, /心跳已过期/);
      assert.doesNotMatch(error.message, /升级/);
      return true;
    });
    const old = harness([agent({ version: entry.older })]);
    await assert.rejects(entry.create(old.service), (error: Error) => {
      assert.match(error.message, /升级/);
      assert.match(error.message, entry.minimum);
      return true;
    });
    assert.equal(expired.tasks.length + old.tasks.length, 0);
  });
}

test('missing tenant scope is rejected before discovery or enqueueing', async () => {
  const h = harness([agent()]);
  const unscoped = { ...user, tenantId: null };
  await assert.rejects(h.service.readiness(unscoped), /tenant scope is required/);
  await assert.rejects(h.service.createParkingQuery(vehicle, unscoped), /tenant scope is required/);
  assert.equal(h.agentFinds.length, 0);
  assert.equal(h.tasks.length, 0);
});

test('fee query authorization is still checked before discovery or enqueueing', async () => {
  const h = harness([agent()]);
  await assert.rejects(h.service.createParkingFeeReport(dates, user, { scopeAll: false } as any), /全公司数据范围/);
  await assert.rejects(h.service.createParkingFeeDetail({ ...dates, category: 'renewal', page: 1 }, user, { scopeAll: false } as any), /全公司停车金额明细/);
  assert.equal(h.agentFinds.length, 0);
  assert.equal(h.tasks.length, 0);
});
