import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateLocalIntegrations } from './production-local-integration-migration';
const adapter = (pg: PGlite): any => ({ query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows });

test('both fast and full deployment apply only the scoped migration before reloading; fast failure restores previous dist', () => {
  const script = readFileSync(resolve(__dirname, '../../../deploy/srv-deploy-api.sh'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(script, /migrate_standard_integrations\(\) \{\n  if \[ -f api\/dist\/production-local-integration-migration\.js \]; then\n    \(cd api && node dist\/production-local-integration-migration\.js --apply\)/);
  assert.match(script, /cp "\$STAGE\/api\/ecosystem.config.cjs" api\/ecosystem.config.cjs\n  migrate_standard_integrations\n  pm2 reload pms-api/);
  assert.match(script, /migrate_standard_integrations\necho "--- pm2 reload ---"\npm2 reload pms-api/);
  assert.match(script, /trap cleanup_fast EXIT/);
  assert.match(script, /mv "\$OLD_DIST" api\/dist/);
  assert.doesNotMatch(script, /migration:run|runMigrations\(/);
});

test('production integration migration defaults to read-only; no missing table or ledger is created', async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE business_sentinel(id int PRIMARY KEY,value text); INSERT INTO business_sentinel VALUES(1,'unchanged')");
    const result = await migrateLocalIntegrations(adapter(pg));
    assert.equal(result.mode, 'read-only');
    assert.equal(result.businessRowsWritten, 0);
    assert.deepEqual(result.tablesPresentBefore, []);
    assert.deepEqual((await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows, [{ tablename:'business_sentinel' }]);
    assert.deepEqual((await pg.query('SELECT * FROM business_sentinel')).rows, [{id:1,value:'unchanged'}]);
  } finally { await pg.close(); }
});

test('explicit two-migration apply is atomic and idempotent, retains business data and never runs old pending migrations', async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE business_sentinel(id int PRIMARY KEY,value text); INSERT INTO business_sentinel VALUES(1,'unchanged'); CREATE TABLE migrations(id int,timestamp bigint,name text); INSERT INTO migrations VALUES(1,123,'old-pending-is-not-run')");
    await migrateLocalIntegrations(adapter(pg), true);
    await pg.query("INSERT INTO local_integrations(tenant_id,key,name,kind,token_hash) VALUES(1,'synthetic-local','synthetic','workstation',$1)", ['0'.repeat(64)]);
    await pg.exec("INSERT INTO local_integration_tasks(tenant_id,integration_key,resource_id,operation,idempotency_key,command) VALUES(1,'synthetic-local','reader','card.inspect','synthetic-task','{}')");
    const before = (await pg.query('SELECT * FROM local_integration_tasks')).rows;
    const result = await migrateLocalIntegrations(adapter(pg), true);
    assert.deepEqual(result.tablesPresentBefore, ['local_integration_tasks','local_integrations']);
    assert.deepEqual((await pg.query('SELECT * FROM local_integration_tasks')).rows, before);
    assert.equal((await pg.query<any>('SELECT count(*)::int AS n FROM local_integrations')).rows[0].n, 1);
    assert.deepEqual((await pg.query('SELECT * FROM business_sentinel')).rows, [{id:1,value:'unchanged'}]);
    assert.deepEqual((await pg.query('SELECT * FROM migrations')).rows, [{id:1,timestamp:123,name:'old-pending-is-not-run'}]);
  } finally { await pg.close(); }
});

test('schema drift fails closed and rolls back newly created tables/indexes without touching existing data', async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE local_integrations(id text PRIMARY KEY,tenant_id int,key varchar(80) UNIQUE,name varchar(100),kind varchar(30),token_hash varchar(64)); INSERT INTO local_integrations VALUES('retained',1,'local-synthetic','synthetic','workstation','synthetic')");
    await assert.rejects(migrateLocalIntegrations(adapter(pg), true), /schema drift/);
    assert.equal((await pg.query<any>("SELECT to_regclass('public.local_integration_tasks') AS name")).rows[0].name, null);
    assert.equal((await pg.query<any>('SELECT id FROM local_integrations')).rows[0].id, 'retained');
  } finally { await pg.close(); }
});
