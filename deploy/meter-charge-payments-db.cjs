#!/usr/bin/env node
/** Scoped additive meter payment migration. Never prints credentials or overwrites runtime configuration. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const APP = '/opt/pms-repair/apps/api';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function main() {
  const mode = process.argv[2] || 'baseline';
  if (!['baseline','migrate','verify'].includes(mode) || process.platform !== 'linux') throw Error('Unsupported mode or host');
  const req = createRequire(path.join(APP, 'package.json'));
  const envFile = path.join(APP, '.env');
  const fileEnv = req('dotenv').parse(fs.readFileSync(envFile));
  const service = JSON.parse(execFileSync('pm2', ['jlist'], { encoding:'utf8', maxBuffer:4*1024*1024 })).find(row => row.name === 'pms-api');
  if (!service || service.pm2_env.pm_cwd !== APP) throw Error('Unexpected PMS service identity');
  const runtime = { ...fileEnv, ...Object.fromEntries(Object.entries(service.pm2_env).filter(([key]) => key.startsWith('DB_'))) };
  const config = { host:runtime.DB_HOST || 'localhost', port:Number(runtime.DB_PORT || 5432), user:runtime.DB_USER || 'pms', password:runtime.DB_PASS || '', database:runtime.DB_NAME || 'pms_repair', connectionTimeoutMillis:10000 };
  const identityHash = hash(JSON.stringify([config.host,config.port,config.user,config.database]));
  if (mode === 'migrate' && process.argv[3] !== identityHash) throw Error('Database identity fingerprint mismatch');
  const client = new (req('pg').Client)(config);
  await client.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS database, inet_server_addr()::text AS server')).rows[0];
    const configs = (await client.query("SELECT tenant_id, key, value FROM tenant_configs WHERE key IN ('meter_vision','ai_assist','wx_service_account','wx_subscribe_templates','auto_review_hours','dispatch_escalation') ORDER BY tenant_id,key")).rows.map(row => ({tenantId:row.tenant_id,key:row.key,hash:hash(JSON.stringify(row.value)),enabled:typeof row.value?.enabled === 'boolean' ? row.value.enabled : undefined}));
    const counts = {};
    for (const table of ['meters','meter_readings','meter_charges']) counts[table] = Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    let exists = !!(await client.query("SELECT to_regclass('public.meter_charge_payments') AS name")).rows[0].name;
    let backup;
    if (mode === 'migrate' && !exists) {
      if (Object.values(counts).reduce((sum,n)=>sum+n,0) > 50000) throw Error('Use database-native backup for this volume before migration');
      backup = `/opt/pms-repair/backups/meter-review-${new Date().toISOString().replace(/[:.]/g,'-')}`;
      fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.chmodSync(backup,0o700);
      fs.copyFileSync(envFile,path.join(backup,'api.env'));fs.chmodSync(path.join(backup,'api.env'),0o600);
      fs.cpSync(path.join(APP,'dist'),path.join(backup,'api-dist'),{recursive:true});
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        for (const table of ['meters','meter_readings','meter_charges']) {
          const rows = (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
          fs.writeFileSync(path.join(backup,`${table}.json`),JSON.stringify(rows),{mode:0o600});
        }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK');throw error; }
      // This exact compiled migration must come from the frozen, pushed release build.
      const migrationFile = process.argv[4];
      if (!migrationFile || !path.isAbsolute(migrationFile)) throw Error('Provide frozen compiled migration path');
      const { MeterChargePayments1792900000002 } = require(migrationFile);
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(1792900002)');
        exists = !!(await client.query("SELECT to_regclass('public.meter_charge_payments') AS name")).rows[0].name;
        if (!exists) await new MeterChargePayments1792900000002().up({query:(sql,params)=>client.query(sql,params)});
        if ((await client.query("SELECT to_regclass('public.migrations') AS name")).rows[0].name) {
          await client.query("INSERT INTO migrations(timestamp,name) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM migrations WHERE name=$2)",[1792900000002,'MeterChargePayments1792900000002']);
        }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK');throw error; }
      exists = true;
    }
    const columns = exists ? (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='meter_charge_payments' ORDER BY ordinal_position")).rows.map(row=>row.column_name) : [];
    if (mode !== 'baseline' && (!exists || !['client_request_id','request_fingerprint','amount_cents','operator_id'].every(name=>columns.includes(name)))) throw Error('Payment journal schema verification failed');
    console.log(JSON.stringify({at:new Date().toISOString(),mode,identity,identityHash,envHash:hash(fs.readFileSync(envFile)),configs,counts,paymentJournalExists:exists,columns,backup},null,2));
  } finally { await client.end(); }
}
main().catch(error=>{console.error('Meter DB operation failed:',error.message);process.exitCode=1;});
