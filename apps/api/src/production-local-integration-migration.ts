import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DataSource, QueryRunner } from 'typeorm';
import { LocalIntegrations1796200000000 } from './migrations/1796200000000-LocalIntegrations';
import { StandardCardIssuance1796200100000 } from './migrations/1796200100000-StandardCardIssuance';

import { StandardParkingQuery1796200200000 } from './migrations/1796200200000-StandardParkingQuery';

// Explicit three-migration allowlist, never a glob/all-pending runner or API startup hook.
// Only new integration tables/indexes are added; no existing business row is modified.
const tables = ['local_integrations', 'local_integration_tasks'];
const required: Record<string, string[]> = {
  local_integrations: ['id','tenant_id','key','name','kind','token_hash','enabled','resources','ready','version','last_seen_at','created_at','updated_at','created_by','updated_by'],
  local_integration_tasks: ['id','tenant_id','integration_key','resource_id','operation','revision','idempotency_key','command','status','lease_token','lease_expires_at','result','completed_at','created_at','updated_at','created_by','updated_by','issuance_item_id','allocation_id','parking_query_id'],
};
type Sql = Pick<QueryRunner, 'query'>;
export async function migrateLocalIntegrations(q: Sql, apply = false) {
  await q.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    await q.query("SET LOCAL lock_timeout = '5s'");
    await q.query("SET LOCAL statement_timeout = '30s'");
    const before = await q.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name", [tables]);
    if (apply) {
      await q.query('SELECT pg_advisory_xact_lock(1796200, 1)');
      await new LocalIntegrations1796200000000().up(q as QueryRunner);
      await new StandardCardIssuance1796200100000().up(q as QueryRunner);
      await new StandardParkingQuery1796200200000().up(q as QueryRunner);
      const columns = await q.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1)", [tables]);
      for (const [table, names] of Object.entries(required)) for (const name of names) {
        const column = columns.find((c: any) => c.table_name === table && c.column_name === name);
        assert.ok(column, `Integration schema drift: missing ${table}.${name}`);
        if (['id','tenant_id','issuance_item_id','allocation_id','parking_query_id'].includes(name)) assert.equal(column.data_type, 'integer', `Integration schema drift: ${name} type`);
        if (['issuance_item_id','allocation_id','parking_query_id'].includes(name)) assert.equal(column.is_nullable, 'YES', `Integration schema drift: ${name} nullability`);
      }
      const indexes = await q.query("SELECT tablename,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)", [tables]);
      for (const [table, fragment] of [['local_integrations','(key)'],['local_integrations','(tenant_id, name)'],['local_integration_tasks','(tenant_id, integration_key, idempotency_key)'],['local_integration_tasks','(tenant_id, issuance_item_id, operation) WHERE (issuance_item_id IS NOT NULL)'],['local_integration_tasks','(tenant_id, parking_query_id) WHERE (parking_query_id IS NOT NULL)']]) {
        assert.ok(indexes.some((i: any) => i.tablename === table && i.indexdef.includes('CREATE UNIQUE INDEX') && i.indexdef.includes(fragment)), `Integration schema drift: unique ${fragment}`);
      }
    }
    await q.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { mode: apply ? 'apply' : 'read-only', migrations: ['1796200000000','1796200100000','1796200200000'], tablesPresentBefore: before.map((r: any) => r.table_name), businessRowsWritten: 0 };
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 1 && ['--check','--apply'].includes(args[0]), 'Expected --check or --apply');
  require('dotenv').config();
  assert.equal(process.env.NODE_ENV, 'production', 'Only the installed production API environment is allowed');
  const db = new DataSource({ type:'postgres', host:process.env.DB_HOST || 'localhost', port:Number(process.env.DB_PORT || 5432), username:process.env.DB_USER || 'pms', password:process.env.DB_PASS || '', database:process.env.DB_NAME || 'pms_repair', synchronize:false });
  await db.initialize();
  const q = db.createQueryRunner();
  try {
    await q.connect();
    const [identity] = await q.query('SELECT current_database() AS database,current_user AS "user",inet_server_addr()::text AS address,inet_server_port() AS port');
    assert.equal(identity.database, 'pms_repair', 'Unexpected production database');
    assert.equal(identity.user, 'pms', 'Unexpected production database user');
    console.log(JSON.stringify({ identity, ...await migrateLocalIntegrations(q, args[0] === '--apply') }));
  } finally { await q.release(); await db.destroy(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
