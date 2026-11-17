import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { LocalIntegrations1796200000000 } from '../../migrations/1796200000000-LocalIntegrations';
import { StandardCardIssuance1796200100000 } from '../../migrations/1796200100000-StandardCardIssuance';
import { LocalIntegrationsService } from './local-integrations.service';
import { validateCommand, validateResources, validateResult } from './protocol';
import { LocalIntegrationsController } from './local-integrations.controller';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const user = { id: 7, tenantId: 1, role: 'tenant_admin' };
const resources: any = [{ id: 'site.main', label: '现场资源', capabilities: [{ operation: 'access.query', revision: 1 }, { operation: 'card.write', revision: 1 }, { operation: 'access.controller.apply', revision: 1 }] }];
async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities: [LocalIntegration, LocalIntegrationTask], synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (connection: any, active = false): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: active, data: {},
      connect: async () => undefined, release: async () => undefined,
      startTransaction: async () => undefined, commitTransaction: async () => undefined, rollbackTransaction: async () => undefined,
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await connection.query(sql, params); if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr); return qr;
  };
  (ds as any).isInitialized = true; ds.createQueryRunner = () => runner(pg);
  // TypeORM EntityManager.transaction creates its own runner, so implement transaction boundaries
  // on the actual PGlite connection rather than pretending locks run outside a transaction.
  ds.manager.transaction = ((callback: any) => pg.transaction((tx: any) => callback(runner(tx, true).manager))) as any;
  const migration = new LocalIntegrations1796200000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  await new StandardCardIssuance1796200100000().up({ query: (sql: string) => pg.query(sql) } as any);
  const { StandardParkingQuery1796200200000 } = require('../../migrations/1796200200000-StandardParkingQuery');
  await new StandardParkingQuery1796200200000().up({ query: (sql: string) => pg.query(sql) } as any);
  return { pg, ds, service: new LocalIntegrationsService(ds.getRepository(LocalIntegration), ds.getRepository(LocalIntegrationTask)) };
}
test('business contract rejects vendor SQL, unknown revisions and unverified physical success', () => {
  assert.throws(() => validateResources([{ ...resources[0], capabilities: [{ operation: 'vendor.sql', revision: 1 }] }]));
  assert.throws(() => validateCommand('access.query', { query: { field: 'card', value: '123', sql: 'SELECT *' } }));
  assert.throws(() => validateCommand('card.write', { card: { number: '123' } }));
  assert.throws(() => validateResult('card.write', { outcome: 'succeeded', evidence: 'database_readback' }));
  assert.doesNotThrow(() => validateResult('card.write', { outcome: 'succeeded', evidence: 'card_readback' }));
  assert.throws(() => validateResult('access.query', { outcome: 'succeeded', evidence: 'observed', records: [{ password: 'secret' }] }));
  for (const validUntil of ['2026-02-30', '2026-01-01T24:00:00Z', '2026-01-01TanythingZ'])
    assert.throws(() => validateCommand('access.grant', { card: { number: '123' }, authorization: { targetIds: ['door.main'], validUntil } }), /validity date/);
  assert.throws(() => validateCommand('access.grant', { card: { number: '123' }, authorization: { targetIds: ['door.main'], validFrom: '2026-02-01', validUntil: '2026-01-01' } }), /validity range/);
  assert.doesNotThrow(() => validateCommand('access.grant', { card: { number: '123' }, authorization: { targetIds: ['door.main'], validUntil: '2028-02-29T23:59:59.999Z' } }));
});
test('partial community scope cannot administer tenant-wide integrations', () => {
  const controller = new LocalIntegrationsController({ list: () => { throw new Error('must not query'); } } as any);
  assert.throws(() => controller.list(user, { scopeAll: false } as any), /全部小区/);
});
test('real persisted enroll → heartbeat → claim → report; isolation, idempotency and safe key rotation', async () => {
  const { pg, service } = await fixture();
  try {
    const enrolled = await service.enroll({ name: '现场一号', kind: 'service', resources }, user);
    assert.equal('tokenHash' in enrolled, false);
    await assert.rejects(service.enroll({ name: '现场一号', kind: 'service', resources }, user), /名称已存在/);
    await service.authenticate(enrolled.key, enrolled.token);
    await assert.rejects(service.authenticate(enrolled.key, 'wrong'), /无效/);
    await assert.rejects(service.rotate(enrolled.key, { ...user, tenantId: 2 }), /不存在/);
    const dto: any = { resourceId: 'site.main', operation: 'access.query', revision: 1, idempotencyKey: 'read-001', command: { query: { field: 'card', value: '123' } } };
    const task = await service.createTask(enrolled.key, dto, user);
    assert.equal((await service.claim(enrolled.key, enrolled.token)).task, null);
    await service.heartbeat(enrolled.key, enrolled.token, { protocolVersion: '1.0', version: '1.0.0', ready: resources });
    await assert.rejects(service.heartbeat(enrolled.key, enrolled.token, { protocolVersion: '1.0', version: '1', ready: [{ ...resources[0], id: 'not-registered' }] }), /超出/);
    assert.equal((await service.createTask(enrolled.key, dto, user)).id, task.id);
    await assert.rejects(service.createTask(enrolled.key, { ...dto, command: { query: { field: 'card', value: '456' } } }, user), /幂等键/);
    const claim = await service.claim(enrolled.key, enrolled.token);
    assert.equal(claim.task!.id, task.id);
    assert.equal((await service.claim(enrolled.key, enrolled.token)).task, null);
    const result = { outcome: 'succeeded', evidence: 'observed', records: [{ cardNumber: '123', status: 'active' }] };
    await assert.rejects(service.report(enrolled.key, enrolled.token, task.id, { leaseToken: 'a'.repeat(64), result }), /租约/);
    const report = { leaseToken: claim.task!.leaseToken!, result };
    assert.equal((await service.report(enrolled.key, enrolled.token, task.id, report)).status, 'succeeded');
    assert.equal((await service.report(enrolled.key, enrolled.token, task.id, report)).status, 'succeeded');
    await assert.rejects(service.report(enrolled.key, enrolled.token, task.id, { ...report, result: { outcome: 'failed', code: 'ERROR' } }), /不能覆盖/);
    assert.equal('leaseToken' in await service.getTask(enrolled.key, task.id, user), false);
    const rotated = await service.rotate(enrolled.key, user);
    await assert.rejects(service.authenticate(enrolled.key, enrolled.token), /无效/);
    await service.authenticate(enrolled.key, rotated.token);
    await service.enable(enrolled.key, false, user);
    await assert.rejects(service.authenticate(enrolled.key, rotated.token), /无效/);
  } finally { await pg.close(); }
});
test('in-flight stale heartbeat cannot restore a rotated credential or disabled connection', async () => {
  const { pg, service } = await fixture();
  try {
    const agent = await service.enroll({ name: '心跳竞争', kind: 'service', resources }, user);
    const authenticate = service.authenticate.bind(service);
    let replacement = '';
    service.authenticate = (async (...args: Parameters<typeof authenticate>) => {
      const stale = await authenticate(...args);
      replacement = (await service.rotate(agent.key, user)).token;
      return stale;
    }) as typeof service.authenticate;
    await assert.rejects(service.heartbeat(agent.key, agent.token, { protocolVersion: '1.0', version: '1', ready: resources }), /已轮换/);
    service.authenticate = authenticate;
    await assert.rejects(service.authenticate(agent.key, agent.token), /无效/);
    assert.equal((await service.authenticate(agent.key, replacement)).ready.length, 0);
    service.authenticate = (async (...args: Parameters<typeof authenticate>) => {
      const stale = await authenticate(...args);
      await service.enable(agent.key, false, user);
      return stale;
    }) as typeof service.authenticate;
    await assert.rejects(service.heartbeat(agent.key, replacement, { protocolVersion: '1.0', version: '1', ready: resources }), /已停用/);
    service.authenticate = authenticate;
    await assert.rejects(service.authenticate(agent.key, replacement), /无效/);
  } finally { await pg.close(); }
});
test('official normalized task → HTTP adapter → real SQLite read → persisted normalized result', async () => {
  const { pg, service } = await fixture();
  const { DatabaseSync } = require('node:sqlite');
  const { run, transport } = require('../../../../../tools/local-integration-adapter/runner.cjs');
  const { createAdapter } = require('../../../../../tools/local-integration-adapter/sqlite-readonly.example.cjs');
  const directory = resolve(__dirname, '../../../../../outputs/omission-release-20261117/standard/protocol-sqlite', String(Date.now()));
  mkdirSync(directory, { recursive: true });
  const databasePath = join(directory, 'site.sqlite');
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("CREATE TABLE PermitCards(CardNo TEXT, HolderName TEXT, Room TEXT, Enabled INTEGER); INSERT INTO PermitCards VALUES('123','合成住户','1/101',1)");
  sqlite.close();
  const adapter = createAdapter({ databasePath });
  const agent = await service.enroll({ name: '真实SQLite适配器契约测试', kind: 'service', resources: await adapter.ready() }, user);
  const task = await service.createTask(agent.key, { resourceId: 'site.main', operation: 'access.query', revision: 1, idempotencyKey: 'sqlite-read-001', command: { query: { field: 'card', value: '123' } } }, user);
  const abort = new AbortController();
  // An isolated HTTP bridge exercises real request/response serialization + service persistence.
  // Nest's deployed authentication/DTO middleware is not replaced or claimed as tested by this bridge.
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const prefix = `/api/v1/local-integration-agent/v1/${agent.key}/`;
      if (!req.url?.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const route = req.url.slice(prefix.length);
      const result = route === 'heartbeat' ? await service.heartbeat(agent.key, token, body)
        : route === 'claim' ? await service.claim(agent.key, token)
          : await service.report(agent.key, token, Number(route.split('/')[1]), body);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
      if (route.endsWith('/report')) abort.abort();
    } catch { res.writeHead(400).end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const address = server.address() as { port: number };
    await run({ adapter, directory, integrationKey: agent.key, signal: abort.signal, pollMs: 10, log: () => {},
      post: transport(`http://127.0.0.1:${address.port}/api/v1`, agent.key, agent.token) });
    const saved = await service.getTask(agent.key, task.id, user);
    assert.equal(saved.status, 'succeeded');
    assert.deepEqual(saved.result, { outcome: 'succeeded', evidence: 'observed', records: [{ cardNumber: '123', name: '合成住户', room: '1/101', status: 'active' }] });
  } finally { clearTimeout(timer); await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); }
});
test('expired physical tasks become unknown and are never automatically reissued', async () => {
  const { pg, service } = await fixture();
  try {
    const agent = await service.enroll({ name: '写卡机', kind: 'workstation', resources }, user);
    await service.heartbeat(agent.key, agent.token, { protocolVersion: '1.0', version: '1', ready: resources });
    await assert.rejects(service.createTask(agent.key, { resourceId: 'site.main', operation: 'card.write', revision: 1, idempotencyKey: 'write-001', command: { card: { number: '123', profileId: 'local-profile', allocationId: 'reserved-001' } } }, user), /真实卡号分配/);
    const task = await service.createTask(agent.key, { resourceId: 'site.main', operation: 'access.controller.apply', revision: 1, idempotencyKey: 'controller-001', command: { card: { number: '123' }, authorization: { targetIds: ['door.main'] } } }, user);
    const claimed = await service.claim(agent.key, agent.token);
    await pg.query(`UPDATE local_integration_tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [task.id]);
    assert.equal((await service.claim(agent.key, agent.token)).task, null);
    assert.equal((await service.getTask(agent.key, task.id, user)).status, 'unknown');
    // A late durable readback result may reconcile the same lease, but never a new execution.
    const late = await service.report(agent.key, agent.token, task.id, { leaseToken: claimed.task!.leaseToken!, result: { outcome: 'succeeded', evidence: 'controller_ack' } });
    assert.equal(late.status, 'succeeded');
  } finally { await pg.close(); }
});
