import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessCardIssuanceService } from '../access-card-issuance/access-card-issuance.service';
import { hashAgentToken } from '../access-card-issuance/agent-auth';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, ParkingQuery, TenantConfig, ParkingHistory, ParkingRecordSnapshot, AccessCardAgent } from '../../entities';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { migrateLocalIntegrations } from '../../production-local-integration-migration';
import { ParkingHistory1789434000000 } from '../../migrations/1789434000000-ParkingHistory';
import { ParkingHistoryOperationTime1789531200000 } from '../../migrations/1789531200000-ParkingHistoryOperationTime';
import { StandardParkingQueryService } from './standard-parking-query.service';
import { LocalIntegrationsService } from './local-integrations.service';
import { LocalIntegrationsController } from './local-integrations.controller';

const resources: any = [{ id: 'parking.synthetic', label: '合成停车只读资源', capabilities: [{ operation: 'parking.query', revision: 1 }] }];
async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities, synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (connection: any, active = false): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: active, data: {}, connect: async () => {}, release: async () => {},
      startTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await connection.query(sql, params); if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr); return qr;
  };
  (ds as any).isInitialized = true; ds.createQueryRunner = () => runner(pg);
  ds.manager.transaction = ((cb: any) => pg.transaction((tx: any) => cb(runner(tx, true).manager))) as any;
  await migrateLocalIntegrations({ query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows } as any, true);
  // Existing legacy tables use their real TypeORM column metadata; new integration DDL runs its actual migrations above.
  for (const entity of [ParkingQuery, TenantConfig, AccessCardAgent]) {
    const metadata = ds.getMetadata(entity);
    const columns = metadata.columns.map(column => {
      const type = column.isGenerated ? 'serial' : ds.driver.createFullType({ ...column, type: ds.driver.normalizeType(column) } as any);
      const value = ds.driver.normalizeDefault(column);
      return `"${column.databaseName}" ${type}${column.isPrimary ? ' PRIMARY KEY' : ''}${column.isNullable ? '' : ' NOT NULL'}${value == null ? '' : ` DEFAULT ${value}`}`;
    });
    await pg.exec(`CREATE TABLE "${metadata.tableName}" (${columns.join(',')})`);
  }
  await pg.exec('CREATE UNIQUE INDEX synthetic_config_key ON tenant_configs(tenant_id,key)');
  const qr: any = { query: (sql: string) => pg.query(sql) };
  await new ParkingHistory1789434000000().up(qr);
  await new ParkingHistoryOperationTime1789531200000().up(qr);
  const standard = new StandardParkingQueryService(ds.getRepository(LocalIntegrationTask));
  const local = new LocalIntegrationsService(ds.getRepository(LocalIntegration), ds.getRepository(LocalIntegrationTask), undefined, standard);
  const legacy = Object.create(AccessCardIssuanceService.prototype) as any;
  Object.assign(legacy, { standardParkingQueries: standard, agentRepo: ds.getRepository(AccessCardAgent), config: { get: () => undefined }, deliyun: { status: async () => ({ enabled: false }) },
    communityRepo: { find: async () => [] },
    parkingQueryRepo: { manager: { connection: { query: async () => [] }, transaction: (cb: any) => ds.manager.transaction(cb) }, findOne: (options: any) => ds.getRepository(ParkingQuery).findOne(options) } });
  const enrolled = await local.enroll({ name: '合成停车', kind: 'service', resources }, user);
  await local.heartbeat(enrolled.key, enrolled.token, { protocolVersion: '1.0', version: 'synthetic-1', ready: resources });
  const route = { integrationKey: enrolled.key, resourceId: resources[0].id };
  return { pg, ds, local, standard, legacy, enrolled, route };
}
const projection = (name = '合成姓名') => ({ externalId: 'synthetic-car-1', plate: '沪ATEST1', ownerId: 'synthetic-owner-1', name, phone: null, room: null, note: null, plateChangedAt: null });

const user = { id: 7, tenantId: 1, role: 'tenant_admin' } as any;
test('formal parking query uses the configured standard transport before legacy discovery', async () => {
  const service = Object.create(AccessCardIssuanceService.prototype) as any;
  let called = false;
  Object.assign(service, {
    communityRepo: { find: async () => [] },
    parkingQueryRepo: { manager: { connection: { query: async () => [] } } },
    agentRepo: { find: async () => [] },
    standardParkingQueries: { tryCreateVehicleQuery: async (term: string, database: string, actor: any) => {
      called = true;
      assert.equal(term, '沪ATEST1'); assert.equal(database, 'parking2'); assert.equal(actor.tenantId, 1);
      return { id: 92, tenantId: 1, term, database, status: 'running', rows: [] };
    } },
  });
  const result = await service.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user);
  assert.equal(called, true);
  assert.equal(result.id, 92); assert.equal(result.status, 'running'); assert.deepEqual(result.rows, []);
});

test('formal query → standard claim/report → canonical save/readback/history is transactional and replay-safe', async () => {
  const h = await fixture();
  try {
    await h.standard.setRoutes({ parking2: h.route }, user);
    assert.deepEqual(await h.standard.getRoutes(user), { parking2: h.route });
    await h.ds.getRepository(AccessCardAgent).save({ tenantId: 1, agentKey: 'synthetic-legacy', kind: 'parking_gateway', name: '合成旧网关',
      version: '2.5.54', tokenHash: hashAgentToken('synthetic-test-only'), enabled: true, status: 'online', capabilities: { parkingDbRead: true }, lastSeenAt: new Date() });
    const plateChangedAt = new Date(Date.now() - 86_400_000).toISOString();
    for (const name of ['首次合成姓名', '变更合成姓名']) {
      const requested = await h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user);
      assert.equal(requested.status, 'running');
      const canonical = await h.ds.getRepository(ParkingQuery).findOneByOrFail({ id: requested.id });
      assert.equal(canonical.leaseAgentKey, null); assert.equal(canonical.leaseExpiresAt, null);
      assert.equal((await h.legacy.claimParkingQuery('synthetic-legacy', 'synthetic-test-only')).task, null);
      await assert.rejects(h.legacy.reportParkingQuery('synthetic-legacy', 'synthetic-test-only', { queryId: requested.id, result: 'success', rows: [] }), /不属于当前网关/);
      const task: any = (await h.local.claim(h.enrolled.key, h.enrolled.token)).task;
      assert.equal(task.operation, 'parking.query'); assert.equal(task.parkingQueryId, requested.id);
      const report = { leaseToken: task.leaseToken, result: { outcome: 'succeeded', evidence: 'observed', records: [{ ...projection(name), plateChangedAt }] } };
      await h.local.report(h.enrolled.key, h.enrolled.token, task.id, report);
      await h.local.report(h.enrolled.key, h.enrolled.token, task.id, report);
      const readback = await h.legacy.getParkingQuery(requested.id, user);
      assert.equal(readback.status, 'completed'); assert.equal(readback.rows[0].fields.Owner__name, name);
      await assert.rejects(h.legacy.getParkingQuery(requested.id, { ...user, tenantId: 2 }), /不存在/);
    }
    const snapshot = await h.ds.getRepository(ParkingRecordSnapshot).findOneByOrFail({ tenantId: 1, sourceRecordId: 'synthetic-car-1' });
    assert.equal(snapshot.values.ownerName, '变更合成姓名');
    assert.equal(snapshot.values.plateChangedAt, plateChangedAt);
    const histories = await h.ds.getRepository(ParkingHistory).find();
    assert.equal(histories.length, 1); assert.equal(histories[0].eventType, 'owner_info_update');
    assert.equal(histories[0].tenantId, 1);
    await h.local.enable(h.enrolled.key, false, user);
    const readiness = await h.legacy.readiness(user);
    assert.equal(readiness.standardParkingQuery.ready, false);
    assert.equal(readiness.features.parkingDbRead, true, 'offline standard binding must not hide the other legacy database');
    assert.equal(readiness.features.parkingDbWrite, false); assert.equal(readiness.features.controllerUpload, false);
  } finally { await h.pg.close(); }
});

test('standard binding rejects offline, wrong tenant/resource, fuzzy inputs and partial or mismatched receipts without legacy fallback', async () => {
  const h = await fixture();
  try {
    assert.equal(await h.standard.tryCreateVehicleQuery('沪ATEST1', 'parking2', user), null);
    await assert.rejects(h.standard.setRoutes({ parking2: h.route }, { ...user, tenantId: 2 }), /离线|未就绪/);
    await assert.rejects(h.standard.setRoutes({ parking2: { ...h.route, resourceId: 'other' } }, user), /离线|未就绪/);
    await assert.rejects(h.standard.setRoutes({ parking2: { ...h.route, sql: 'not-allowed' } }, user), /必须绑定/);
    await assert.rejects(h.standard.setRoutes({ parking1: h.route, parking2: h.route }, user), /独立的逻辑停车资源/);
    await h.standard.setRoutes({ parking2: h.route }, user);
    assert.equal((await h.standard.readiness(1))?.ready, true);
    const controller = new LocalIntegrationsController(h.local, h.standard);
    assert.throws(() => controller.parkingRoutes(user, { scopeAll: false } as any), /全部小区/);
    assert.throws(() => controller.setParkingRoutes({ routes: {} }, user, { scopeAll: false } as any), /全部小区/);
    await assert.rejects(h.legacy.createParkingQuery({ term: 'TEST1', database: 'parking2' }, user), /仅支持完整车牌/);
    await assert.rejects(h.legacy.createParkingQuery({ term: '沪ATEST1' }, user), /明确选择/);
    assert.equal(await h.ds.getRepository(ParkingQuery).count(), 0);
    await h.local.enable(h.enrolled.key, false, user);
    await assert.rejects(h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user), /不会自动切换/);
    assert.equal((await h.standard.readiness(1))?.ready, false);
    assert.equal(await h.ds.getRepository(ParkingQuery).count(), 0);
    await h.local.enable(h.enrolled.key, true, user);
    await h.local.heartbeat(h.enrolled.key, h.enrolled.token, { protocolVersion: '1.0', version: 'synthetic-1', ready: resources });
    const query = await h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user);
    const task: any = (await h.local.claim(h.enrolled.key, h.enrolled.token)).task;
    for (const records of [[{ plate: '沪ATEST1', externalId: 'partial' }], [{ ...projection(), plate: '沪BOTHER' }], [projection(), projection()], [{ ...projection(), plateChangedAt: '2099-01-01T00:00:00Z' }]]) {
      await assert.rejects(h.local.report(h.enrolled.key, h.enrolled.token, task.id, { leaseToken: task.leaseToken, result: { outcome: 'succeeded', evidence: 'observed', records } }), /完整住户快照|唯一记录号/);
      assert.equal((await h.ds.getRepository(LocalIntegrationTask).findOneByOrFail({ id: task.id })).result, null);
      assert.equal((await h.legacy.getParkingQuery(query.id, user)).status, 'running');
    }
    await h.ds.getRepository(LocalIntegrationTask).update(task.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    assert.equal((await h.local.claim(h.enrolled.key, h.enrolled.token)).task, null);
    assert.equal((await h.legacy.getParkingQuery(query.id, user)).status, 'failed');
    await h.local.report(h.enrolled.key, h.enrolled.token, task.id, { leaseToken: task.leaseToken, result: { outcome: 'succeeded', evidence: 'observed', records: [] } });
    assert.equal((await h.legacy.getParkingQuery(query.id, user)).status, 'completed');
    assert.equal(await h.ds.getRepository(LocalIntegrationTask).count(), 1);
  } finally { await h.pg.close(); }
});

test('task creation and snapshot/history failure roll back the entire original query transaction', async () => {
  const h = await fixture();
  try {
    await h.standard.setRoutes({ parking2: h.route }, user);
    await h.pg.exec('ALTER TABLE local_integration_tasks ADD CONSTRAINT synthetic_reject_task CHECK (parking_query_id IS NULL)');
    await assert.rejects(h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user), /synthetic_reject_task/);
    assert.equal(await h.ds.getRepository(ParkingQuery).count(), 0);
    await h.pg.exec('ALTER TABLE local_integration_tasks DROP CONSTRAINT synthetic_reject_task');
    const requested = await h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user);
    const task: any = (await h.local.claim(h.enrolled.key, h.enrolled.token)).task;
    const report = { leaseToken: task.leaseToken, result: { outcome: 'succeeded', evidence: 'observed', records: [projection()] } };
    await h.pg.exec("ALTER TABLE parking_record_snapshots ADD CONSTRAINT synthetic_reject_snapshot CHECK (source_record_id <> 'synthetic-car-1')");
    await assert.rejects(h.local.report(h.enrolled.key, h.enrolled.token, task.id, report), /synthetic_reject_snapshot/);
    assert.equal((await h.ds.getRepository(LocalIntegrationTask).findOneByOrFail({ id: task.id })).result, null);
    assert.equal((await h.legacy.getParkingQuery(requested.id, user)).status, 'running');
    assert.equal(await h.ds.getRepository(ParkingRecordSnapshot).count(), 0);
    await h.pg.exec('ALTER TABLE parking_record_snapshots DROP CONSTRAINT synthetic_reject_snapshot');
    await h.local.report(h.enrolled.key, h.enrolled.token, task.id, report);
    const second = await h.legacy.createParkingQuery({ term: '沪ATEST1', database: 'parking2' }, user);
    const next: any = (await h.local.claim(h.enrolled.key, h.enrolled.token)).task;
    const changed = { leaseToken: next.leaseToken, result: { outcome: 'succeeded', evidence: 'observed', records: [projection('回滚合成姓名')] } };
    await h.pg.exec("ALTER TABLE parking_history ADD CONSTRAINT synthetic_reject_history CHECK (summary = 'synthetic-rejection-only')");
    await assert.rejects(h.local.report(h.enrolled.key, h.enrolled.token, next.id, changed), /synthetic_reject_history/);
    assert.equal((await h.ds.getRepository(LocalIntegrationTask).findOneByOrFail({ id: next.id })).result, null);
    assert.equal((await h.legacy.getParkingQuery(second.id, user)).status, 'running');
    assert.equal((await h.ds.getRepository(ParkingRecordSnapshot).findOneByOrFail({ sourceRecordId: 'synthetic-car-1' })).values.ownerName, '合成姓名');
    assert.equal(await h.ds.getRepository(ParkingHistory).count(), 0);
    await h.pg.exec('ALTER TABLE parking_history DROP CONSTRAINT synthetic_reject_history');
    await h.local.report(h.enrolled.key, h.enrolled.token, next.id, changed);
    assert.equal((await h.legacy.getParkingQuery(second.id, user)).status, 'completed');
    assert.equal(await h.ds.getRepository(ParkingHistory).count(), 1);
  } finally { await h.pg.close(); }
});
