'use strict';
/** One-off additive migration, NOT an API startup hook or an all-pending TypeORM runner.
 * Default: dry READ ONLY. Never creates missing business tables, classifies old records,
 * edits the TypeORM migrations ledger, or calls down(). Roll back APPLICATION packages
 * and retain additive columns/data. Unknown COMMIT outcome: inspect DB + audit, never retry blindly.
 *
 * Reviewed approval JSON: {sourceCommit:<40hex>,runnerSha256:<64hex>,identity:
 * {database,user,serverAddress,serverPort},migrations:[{id,sourceSha256},...]}
 * createApprovalForReview() produces a PROPOSAL from explicit sources; Lead must review it.
 * Backup receipt JSON: {identity,sha256,bytes,restoreVerifiedAt:<ISO>,verifiedBy:<operator>}.
 * Restore verification is an explicit operator attestation, NOT established by PGDMP magic.
 * CLI also hashes the actual dump and runs pg_restore --list before opening an apply transaction.
 *
 * node deploy/property-archive-details-migration.cjs --api-root <deployed-api>
 *   --migration-root <approved-TS-sources> --approval <reviewed.json> [--apply
 *   --backup <current.dump> --backup-receipt <verified.json> --audit-file <new.jsonl>]
 * Only the exact two source files below are read (never evaluated), no src/dist glob.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const RUNNER_SHA256 = sha(fs.readFileSync(__filename));
const HEX64 = /^[a-f0-9]{64}$/;
const IDENTITY_SQL = `SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
const MIGRATIONS = [
  { id: '1796000000000', file: '1796000000000-PropertyArchiveDetails.ts', statements: [
    'ALTER TABLE houses ADD COLUMN IF NOT EXISTS floor varchar(30), ADD COLUMN IF NOT EXISTS property_nature varchar(60), ADD COLUMN IF NOT EXISTS room_layout varchar(60), ADD COLUMN IF NOT EXISTS remark varchar(500)',
    'ALTER TABLE owner_property_links ADD COLUMN IF NOT EXISTS move_in_date date, ADD COLUMN IF NOT EXISTS billing_start_date date',
    'ALTER TABLE owner_phone_activity ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS confirmation_source varchar(20)',
    'ALTER TABLE owner_phone_events ADD COLUMN IF NOT EXISTS confirmation_source varchar(20)',
  ] },
  { id: '1796100000000', file: '1796100000000-ParkingSpaceCategory.ts', statements: [
    'ALTER TABLE parking_spaces ADD COLUMN IF NOT EXISTS category varchar(20)',
  ] },
];
const spec = (table, name, type, length = null) => ({ table, name, type, length });
const COLUMNS = [
  spec('houses', 'floor', 'varchar', 30), spec('houses', 'property_nature', 'varchar', 60),
  spec('houses', 'room_layout', 'varchar', 60), spec('houses', 'remark', 'varchar', 500),
  spec('owner_property_links', 'move_in_date', 'date'), spec('owner_property_links', 'billing_start_date', 'date'),
  spec('owner_phone_activity', 'last_confirmed_at', 'timestamptz'), spec('owner_phone_activity', 'confirmation_source', 'varchar', 20),
  spec('owner_phone_events', 'confirmation_source', 'varchar', 20), spec('parking_spaces', 'category', 'varchar', 20),
];
const BASE = [spec('houses', 'id', 'int4'), spec('houses', 'tenant_id', 'int4'), spec('houses', 'building_id', 'int4'), spec('houses', 'room_no', 'varchar', 30),
  ...['owner_property_links','owner_phone_activity','owner_phone_events'].flatMap(table => [spec(table,'tenant_id','int4'),spec(table,'owner_id','int4')]),
  spec('owner_property_links','house_id','int4'),spec('owner_property_links','building_id','int4'),
  spec('owner_phone_activity','phone','varchar',30),spec('owner_phone_events','phone','varchar',30),
  spec('parking_spaces','id','int4'),spec('parking_spaces','tenant_id','int4'),spec('parking_spaces','garage','varchar',20),spec('parking_spaces','space_no','varchar',20)];
const TABLES = [...new Set(COLUMNS.map(c => c.table))];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function identityValid(v) { return v && Object.keys(v).sort().join(',') === 'database,serverAddress,serverPort,user' && ['database','user','serverAddress'].every(k => typeof v[k] === 'string' && v[k].length > 0 && v[k].length <= 128) && Number.isInteger(v.serverPort) && v.serverPort > 0 && v.serverPort < 65536; }
function sameIdentity(a,b) { return identityValid(a) && identityValid(b) && ['database','user','serverAddress','serverPort'].every(k => a[k] === b[k]); }
const normalize = sql => sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
function sourceManifest(migrationRoot) {
  return MIGRATIONS.map(m => {
    const source = fs.readFileSync(path.join(migrationRoot, m.file), 'utf8');
    const start = source.indexOf('async up('), end = source.indexOf('async down(');
    if (start < 0 || end < start) fail('MIGRATION_SOURCE_UNSUPPORTED');
    const body = source.slice(start, end);
    const actual = [...body.matchAll(/await\s+\w+\.query\(\s*(['"`])([\s\S]*?)\1\s*\)\s*;?/g)].map(m => normalize(m[2]));
    if (JSON.stringify(actual) !== JSON.stringify(m.statements.map(normalize))) fail('MIGRATION_SQL_DRIFT');
    return { id: m.id, sourceSha256: sha(source) };
  });
}
function createApprovalForReview({ migrationRoot, sourceCommit, identity }) {
  return { sourceCommit, runnerSha256: RUNNER_SHA256, identity: structuredClone(identity), migrations: sourceManifest(migrationRoot) };
}
function validateApproval(approval, migrationRoot) {
  if (!approval || !/^[a-f0-9]{40}$/.test(approval.sourceCommit) || !identityValid(approval.identity)) fail('APPROVAL_INVALID');
  if (approval.runnerSha256 !== RUNNER_SHA256 || RUNNER_SHA256 !== sha(fs.readFileSync(__filename))) fail('RUNNER_HASH_MISMATCH');
  if (JSON.stringify(approval.migrations) !== JSON.stringify(sourceManifest(migrationRoot))) fail('MIGRATION_ALLOWLIST_OR_HASH_MISMATCH');
}
function recentIso(value) {
  const time = typeof value === 'string' && /T.*Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Date.now() - time <= 24 * 3600000 && time - Date.now() <= 300000;
}
async function fileHash(file) {
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function verifyBackup(file, receipt, identity, listArchive = dump => execFileSync('pg_restore', ['--list', dump], { stdio: 'ignore', timeout: 60000 })) {
  if (!receipt || !sameIdentity(receipt.identity, identity) || !HEX64.test(receipt.sha256 || '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 5 || !recentIso(receipt.restoreVerifiedAt) || typeof receipt.verifiedBy !== 'string' || !receipt.verifiedBy.trim()) fail('BACKUP_RECEIPT_INVALID');
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size !== receipt.bytes || Date.now() - stat.mtimeMs > 24 * 3600000 || stat.mtimeMs - Date.now() > 300000) fail('BACKUP_FILE_INVALID');
  const fd = fs.openSync(file, 'r'), magic = Buffer.alloc(5); try { fs.readSync(fd,magic,0,5,0); } finally { fs.closeSync(fd); }
  if (magic.toString() !== 'PGDMP' || await fileHash(file) !== receipt.sha256) fail('BACKUP_HASH_OR_FORMAT_MISMATCH');
  await listArchive(file); // Validate archive structure with PostgreSQL, not just its magic header.
  const after = fs.lstatSync(file);
  if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fileHash(file) !== receipt.sha256) fail('BACKUP_CHANGED_DURING_VALIDATION');
  return { verified: true, identity: structuredClone(identity), sha256: receipt.sha256, bytes: stat.size, restoreVerifiedAt: receipt.restoreVerifiedAt };
}
async function inspectSchema(db) {
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=ANY($1::text[])`, [TABLES])).rows;
  if (tables.length !== TABLES.length || TABLES.some(t => !tables.some(r => r.table_name === t))) fail('DEPENDENCY_MISSING');
  const cols = (await db.query(`SELECT table_name,column_name,udt_name,domain_name,character_maximum_length,is_nullable,column_default,is_generated,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`, [TABLES])).rows;
  const find = c => cols.find(r => r.table_name === c.table && r.column_name === c.name);
  const shape = (c,r) => r && r.udt_name === c.type && (r.character_maximum_length ?? null) === c.length;
  for (const c of BASE) if (!shape(c,find(c))) fail('DEPENDENCY_SCHEMA_DRIFT');
  const missing = [], present = [];
  for (const c of COLUMNS) {
    const r = find(c); if (!r) { missing.push(`${c.table}.${c.name}`); continue; }
    if (!shape(c,r) || r.domain_name !== null || r.is_nullable !== 'YES' || r.column_default !== null || r.is_generated !== 'NEVER' || r.is_identity !== 'NO') fail('SCHEMA_DRIFT');
    present.push(`${c.table}.${c.name}`);
  }
  const constraints=(await db.query(`SELECT con.conname FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class rel ON rel.oid=con.conrelid JOIN pg_catalog.pg_namespace ns ON ns.oid=rel.relnamespace
    WHERE ns.nspname='public' AND rel.relname=ANY($1::text[]) AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=rel.oid AND a.attnum=ANY(con.conkey)
      AND (rel.relname||'.'||a.attname)=ANY($2::text[]))`,[TABLES,COLUMNS.map(c=>`${c.table}.${c.name}`)])).rows;
  if(constraints.length)fail('SCHEMA_DRIFT'); // the approved additive DDL adds no CHECK/unique/FK constraints
  return { missing, present };
}
async function runMigration(db, opts) {
  const { approval, migrationRoot, backupEvidence, audit } = opts;
  const apply = opts.apply === true;
  validateApproval(approval,migrationRoot);
  if (opts.apply !== undefined && opts.apply !== true && opts.apply !== false) fail('EXPLICIT_APPLY_REQUIRED');
  if (apply && (!backupEvidence?.verified || !sameIdentity(backupEvidence.identity,approval.identity) || !HEX64.test(backupEvidence.sha256 || '') || !Number.isSafeInteger(backupEvidence.bytes) || backupEvidence.bytes <= 5 || !recentIso(backupEvidence.restoreVerifiedAt))) fail('VERIFIED_BACKUP_REQUIRED');
  if (apply && typeof audit !== 'function') fail('DURABLE_AUDIT_REQUIRED');
  const base = { sourceCommit: approval.sourceCommit, runnerSha256: approval.runnerSha256, migrations: approval.migrations, identity: approval.identity, mode: apply ? 'apply' : 'dry', rollback: 'restore application packages; retain additive columns; never run down', ...(apply ? { backup: backupEvidence } : {}) };
  const emit = async (status, schema = {}) => { await audit({ ...base, at: new Date().toISOString(), status, ...schema }); };
  let started = false, committed = false, commitAttempted = false;
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY'); started = true;
    await db.query("SET LOCAL lock_timeout = '5s'"); await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
    const identity = (await db.query(IDENTITY_SQL)).rows[0]; if (!sameIdentity(identity,approval.identity)) fail('DATABASE_IDENTITY_MISMATCH');
    if (apply && !(await db.query('SELECT pg_try_advisory_xact_lock(179600,179610) AS locked')).rows[0]?.locked) fail('MIGRATION_BUSY');
    // Check dependencies before LOCK for a controlled error; repeat under locks to close the DDL race.
    let before = await inspectSchema(db);
    if (apply) {
      await db.query(`LOCK TABLE ${TABLES.map(t => `public.${t}`).join(',')} IN ACCESS EXCLUSIVE MODE`);
      before = await inspectSchema(db);
    }
    if (!apply) { await db.query('ROLLBACK'); started=false; return { ...base, committed:false, before }; }
    await emit('prepared', { before });
    for (const m of MIGRATIONS) for (const sql of m.statements) await db.query(sql.replace(/^ALTER TABLE (\w+)/, 'ALTER TABLE public.$1'));
    const after = await inspectSchema(db); if (after.missing.length) fail('POST_MIGRATION_SCHEMA_MISSING');
    await emit('committing', { before, after }); commitAttempted = true;
    await db.query('COMMIT'); committed=true; started=false;
    const afterCommit = await inspectSchema(db); if(afterCommit.missing.length)fail('POST_COMMIT_SCHEMA_MISSING');
    await emit('committed', { before, after: afterCommit });
    return { ...base, committed:true, before, after:afterCommit };
  } catch (error) {
    if (started && !commitAttempted) {
      try { await db.query('ROLLBACK'); started=false; } catch { error.resultUnknown=true; }
      if (apply) { try { await emit(error.resultUnknown ? 'rollback-unknown' : 'rolled-back'); } catch { /* preserve original error; pre-commit journal still identifies this attempt */ } }
    }
    if (commitAttempted) { error.committed=committed; error.resultUnknown=!committed; try { await emit(committed ? 'committed-verification-or-audit-failed' : 'commit-unknown'); } catch {} }
    throw error;
  }
}
function parseArgs(args) {
  const values = {}, allowed = new Set(['--api-root','--migration-root','--approval','--backup','--backup-receipt','--audit-file']);
  for (let i=0;i<args.length;i++) {
    const key=args[i]; if (key==='--apply') { if (values.apply) fail('CLI_ARGUMENT_INVALID'); values.apply=true; continue; }
    if (!allowed.has(key) || values[key] !== undefined || !args[i+1] || args[i+1].startsWith('--')) fail('CLI_ARGUMENT_INVALID'); values[key]=args[++i];
  }
  for (const key of ['--api-root','--migration-root','--approval']) if (!values[key]) fail('CLI_ARGUMENT_REQUIRED');
  if (values.apply) for (const key of ['--backup','--backup-receipt','--audit-file']) if (!values[key]) fail('APPLY_ARGUMENT_REQUIRED');
  if (!values.apply && ['--backup','--backup-receipt','--audit-file'].some(k=>values[k])) fail('DRY_MODE_HAS_WRITE_ARGUMENTS');
  return values;
}
async function main(args) {
  const a = parseArgs(args), root = path.resolve(a['--api-root']);
  const approval=JSON.parse(fs.readFileSync(a['--approval'],'utf8')), migrationRoot=path.resolve(a['--migration-root']);
  validateApproval(approval,migrationRoot);
  const backupEvidence=a.apply ? await verifyBackup(a['--backup'],JSON.parse(fs.readFileSync(a['--backup-receipt'],'utf8')),approval.identity) : undefined;
  // Load only the approved installed API's database driver/config parser, not API startup.
  const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync(path.join(root,'.env')));
  if (env.DB_SYNCHRONIZE === 'true' || !env.DB_HOST || !env.DB_USER || !env.DB_NAME || !/^\d+$/.test(env.DB_PORT || '5432')) fail('DATABASE_CONFIG_UNSAFE');
  const { Client }=require(path.join(root,'node_modules/pg'));
  const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),user:env.DB_USER,password:env.DB_PASS,database:env.DB_NAME,connectionTimeoutMillis:10000,application_name:'pms-approved-additive-migration'});
  let fd, result, failure;
  try {
    if (a.apply) { fd=fs.openSync(a['--audit-file'],'wx',0o600); }
    const audit=event=>{fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);};
    await db.connect();
    result=await runMigration(db,{approval,migrationRoot,apply:a.apply,backupEvidence,audit:a.apply?audit:undefined});
    return result;
  } catch(error) { failure=error; throw error; }
  finally {
    // Cleanup must not erase a COMMIT-unknown/committed flag from the original failure.
    let cleanupError;
    try { if(fd!==undefined)fs.closeSync(fd); } catch(error) {cleanupError=error;}
    try {await db.end();} catch(error) {cleanupError ||= error;}
    if(cleanupError && !failure) {cleanupError.committed=result?.committed===true;throw cleanupError;}
  }
}
module.exports={IDENTITY_SQL,MIGRATIONS,COLUMNS,createApprovalForReview,verifyBackup,inspectSchema,runMigration,parseArgs};
if (require.main === module) main(process.argv.slice(2)).then(result=>console.log(JSON.stringify({ok:true,...result}))).catch(error=>{
  console.error(JSON.stringify({ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'MIGRATION_FAILED',committed:error.committed===true,resultUnknown:error.resultUnknown===true,reason:'Inspect schema and audit before retry; no down() or automatic retry'}));process.exitCode=1;
});
