'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { PGlite } = createRequire(resolve(__dirname, '../apps/api/package.json'))('@electric-sql/pglite');
const runner = require('./property-archive-details-migration.cjs');
const identity = { database: 'isolated_test', user: 'tester', serverAddress: '127.0.0.1', serverPort: 5432 };
const approval = () => runner.createApprovalForReview({ migrationRoot: resolve(__dirname, '../apps/api/src/migrations'), sourceCommit: 'a'.repeat(40), identity });
// Explicit OLD schema: deliberately not TypeORM metadata, no new detail/category columns.
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE houses(id serial PRIMARY KEY,tenant_id int,building_id int,room_no varchar(30));
    CREATE TABLE owner_property_links(id serial PRIMARY KEY,tenant_id int,owner_id int,house_id int,building_id int);
    CREATE TABLE owner_phone_activity(tenant_id int,owner_id int,phone varchar(30),status varchar(20));
    CREATE TABLE owner_phone_events(id serial PRIMARY KEY,tenant_id int,owner_id int,phone varchar(30),result varchar(20));
    CREATE TABLE parking_spaces(id serial PRIMARY KEY,tenant_id int,garage varchar(20),space_no varchar(20),note varchar(60));
    INSERT INTO houses(tenant_id,building_id,room_no) VALUES(1,1,'101');
    INSERT INTO owner_property_links(tenant_id,owner_id,house_id) VALUES(1,7,1);
    INSERT INTO owner_phone_activity VALUES(1,7,'13800000001','unknown');
    INSERT INTO owner_phone_events(tenant_id,owner_id,phone,result) VALUES(1,7,'13800000001','attempted');
    INSERT INTO parking_spaces(tenant_id,garage,space_no,note) VALUES(1,'main','A1','产权旧备注不推断');`);
  const queries = [];
  const db = { query: async (sql, params) => { queries.push(sql); if (sql === runner.IDENTITY_SQL) return { rows: [identity] }; if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] }; return pg.query(sql, params); } };
  const events = [];
  return { pg, db, queries, events, opts: () => ({ approval: approval(), migrationRoot: resolve(__dirname, '../apps/api/src/migrations'), apply: true,
    backupEvidence: { verified: true, identity, sha256: 'b'.repeat(64), bytes: 100, restoreVerifiedAt: new Date().toISOString() }, audit: event => events.push(event) }) };
}
async function column(pg, table, name) { return (await pg.query('SELECT * FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', ['public', table, name])).rows[0]; }

test('旧schema首次添加10列、NULL不推断，保存后重跑保留档案/确认/category历史', async () => {
  const f = await fixture(); try {
    for (const c of runner.COLUMNS) assert.equal(await column(f.pg, c.table, c.name), undefined);
    const first = await runner.runMigration(f.db, f.opts());
    assert.equal(first.committed, true); assert.equal(first.before.missing.length, 10); assert.equal(first.after.missing.length, 0);
    assert.ok(f.queries.some(q => q === "SET LOCAL lock_timeout = '5s'"));
    assert.ok(f.queries.some(q => q === "SET LOCAL statement_timeout = '60s'"));
    for (const c of runner.COLUMNS) { const col = await column(f.pg, c.table, c.name); assert.equal(col.is_nullable, 'YES'); assert.equal(col.column_default, null); }
    assert.equal((await f.pg.query('SELECT category FROM parking_spaces')).rows[0].category, null);
    assert.equal((await f.pg.query('SELECT floor FROM houses')).rows[0].floor, null);
    await f.pg.exec("UPDATE houses SET floor='3',property_nature='公房',room_layout='两室',remark='保留'; UPDATE owner_property_links SET move_in_date='2026-11-01',billing_start_date='2026-11-10'; UPDATE owner_phone_activity SET last_confirmed_at=now(),confirmation_source='cashier'; UPDATE owner_phone_events SET confirmation_source='parking'; UPDATE parking_spaces SET category='rental'");
    const snapshot=()=>Promise.all(['houses','owner_property_links','owner_phone_activity','owner_phone_events','parking_spaces'].map(async table=>(await f.pg.query(`SELECT row_to_json(t) AS data FROM public.${table} t ORDER BY tenant_id`)).rows));
    const saved=await snapshot();
    const second = await runner.runMigration(f.db, f.opts()); assert.equal(second.before.missing.length, 0);
    assert.deepEqual(await snapshot(),saved); // all ten populated fields and every legacy value survive rerun
    assert.equal((await f.pg.query('SELECT remark FROM houses')).rows[0].remark, '保留');
    assert.equal((await f.pg.query('SELECT category,note FROM parking_spaces')).rows[0].category, 'rental');
    assert.equal((await f.pg.query('SELECT note FROM parking_spaces')).rows[0].note, '产权旧备注不推断');
    assert.equal(f.events.at(-1).status, 'committed'); assert.ok(f.events.every(e => e.runnerSha256 && e.sourceCommit));
    assert.equal(f.events.at(-1).after.present.length,10); assert.deepEqual(f.events.at(-1).after.missing,[]);
    assert.ok(!f.queries.some(q => /UPDATE communities|DROP COLUMN|migrations\s*\(/i.test(q)));
  } finally { await f.pg.close(); }
});
test('默认dry真正READ ONLY，无DDL/数据/备份/审计写入；返回待加列而非谎报已迁移', async () => {
  const f = await fixture(); try {
    const opts = f.opts(); delete opts.apply; delete opts.backupEvidence; delete opts.audit;
    const result = await runner.runMigration(f.db, opts);
    assert.equal(result.mode, 'dry'); assert.equal(result.committed, false); assert.equal(result.before.missing.length, 10);
    assert.ok(f.queries.includes('BEGIN READ ONLY')); assert.ok(!f.queries.some(q => /^ALTER|^UPDATE|^INSERT|^CREATE/i.test(q)));
    assert.equal(await column(f.pg, 'houses', 'floor'), undefined);
  } finally { await f.pg.close(); }
});
test('已有列类型/长度/NULL/default漂移和缺依赖表逐项拒绝，绝不部分迁移', async () => {
  for (const bad of ['floor text', 'floor varchar(31)', 'floor varchar(30) NOT NULL DEFAULT \'x\'', "floor varchar(30) DEFAULT 'x'", "floor varchar(30) CHECK(floor <> 'x')"]) {
    const f = await fixture(); try { await f.pg.exec(`ALTER TABLE houses ADD COLUMN ${bad}`); await assert.rejects(() => runner.runMigration(f.db, f.opts()), /SCHEMA_DRIFT/); assert.equal(await column(f.pg, 'parking_spaces', 'category'), undefined); } finally { await f.pg.close(); }
  }
  const f = await fixture(); try { await f.pg.exec('DROP TABLE owner_phone_events'); await assert.rejects(() => runner.runMigration(f.db, f.opts()), /DEPENDENCY_MISSING/); assert.equal(await column(f.pg, 'houses', 'floor'), undefined); } finally { await f.pg.close(); }
});
test('第5条DDL失败整批rollback，已有旧数据不变，无成功审计', async () => {
  const f = await fixture(); try {
    const query = f.db.query; f.db.query = async (sql, params) => { if (/ALTER TABLE public\.parking_spaces/.test(sql)) throw Object.assign(new Error('injected'), { code: 'XXTEST' }); return query(sql, params); };
    await assert.rejects(() => runner.runMigration(f.db, f.opts()), /injected/);
    for (const c of runner.COLUMNS) assert.equal(await column(f.pg, c.table, c.name), undefined);
    assert.equal((await f.pg.query('SELECT note FROM parking_spaces')).rows[0].note, '产权旧备注不推断');
    assert.equal(f.events.at(-1).status, 'rolled-back'); assert.ok(!f.events.some(e => e.status === 'committed'));
  } finally { await f.pg.close(); }
});
test('身份、source/hash、允许清单、备份及审计门禁失败均不执行DDL', async () => {
  const f = await fixture(); try {
    for (const change of [o => o.approval.identity.database='wrong', o => o.approval.sourceCommit='bad', o => o.approval.runnerSha256='0'.repeat(64), o => o.approval.migrations[0].sourceSha256='0'.repeat(64), o => o.approval.migrations.push({id:'1795900000000'}), o => delete o.backupEvidence, o => o.backupEvidence.identity={...identity,user:'wrong'}, o => delete o.audit]) {
      const opts = f.opts(); change(opts); await assert.rejects(() => runner.runMigration(f.db, opts));
    }
    assert.equal(await column(f.pg, 'houses', 'floor'), undefined);
  } finally { await f.pg.close(); }
});
test('并发锁被占/短锁超时/提交前durable审计失败均不留部分列', async () => {
  for(const scenario of ['busy','lock-timeout','audit']) {
    const f=await fixture();try {
      const opts=f.opts(),query=f.db.query;
      f.db.query=async(sql,p)=>{if(scenario==='busy'&&sql.includes('pg_try_advisory_xact_lock'))return {rows:[{locked:false}]};if(scenario==='lock-timeout'&&sql.startsWith('LOCK TABLE'))throw Object.assign(Error('lock timeout'),{code:'55P03'});return query(sql,p);};
      if(scenario==='audit')opts.audit=async()=>{throw Error('journal unavailable');};
      await assert.rejects(()=>runner.runMigration(f.db,opts));
      assert.equal(await column(f.pg,'houses','floor'),undefined); assert.equal(await column(f.pg,'parking_spaces','category'),undefined);
    } finally {await f.pg.close();}
  }
});
test('CLI缺批准/备份显式参数或未知flag即失败；不把字符串当apply', () => {
  const args=['--api-root','api','--migration-root','sources','--approval','review.json'];
  assert.equal(runner.parseArgs(args).apply,undefined);
  for(const invalid of [[],[...args,'--apply'],[...args,'--apply=false'],[...args,'--audit-file','audit.jsonl'],[...args,'--approval','other'],[...args,'--all-pending']])assert.throws(()=>runner.parseArgs(invalid));
});
test('COMMIT响应/提交后审计失败必须标记未知或已提交，禁止伪称rollback/自动重试', async () => {
  for (const scenario of ['commit-response', 'audit']) {
    const f = await fixture(); try {
      const opts = f.opts();
      if (scenario === 'commit-response') { const query=f.db.query; f.db.query=async (sql,p)=>{ const result=await query(sql,p); if(sql==='COMMIT')throw Error('lost response'); return result; }; }
      else opts.audit=e=>{ f.events.push(e); if(e.status==='committed') throw Error('audit full'); };
      await assert.rejects(()=>runner.runMigration(f.db,opts), e=>scenario==='audit'?e.committed===true:e.resultUnknown===true);
      assert.ok(await column(f.pg,'houses','floor')); assert.ok(!f.events.some(e=>e.status==='rolled-back'));
    } finally { await f.pg.close(); }
  }
});
test('备份文件真实hash/身份/恢复验证/新鲜度/pg_restore目录校验均为apply前置条件', async () => {
  const dir=mkdtempSync(resolve(tmpdir(),'pms-migration-test-')); try {
    const path=resolve(dir,'db.dump'); const bytes=Buffer.from('PGDMP validated isolated fixture'); writeFileSync(path,bytes);
    const receipt={identity,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,restoreVerifiedAt:new Date().toISOString(),verifiedBy:'isolated-test'};
    let listed=0; const verify=()=>{listed++;};
    const proof=await runner.verifyBackup(path,receipt,identity,verify); assert.equal(proof.verified,true); assert.equal(listed,1);
    for(const mutate of [r=>r.sha256='0'.repeat(64),r=>r.bytes++,r=>r.identity={...identity,database:'other'},r=>delete r.verifiedBy,r=>r.restoreVerifiedAt='2000-01-01T00:00:00Z']) {const r=structuredClone(receipt);mutate(r);await assert.rejects(()=>runner.verifyBackup(path,r,identity,verify));}
    await assert.rejects(()=>runner.verifyBackup(path,receipt,identity,()=>{throw Error('invalid archive');}));
    writeFileSync(path,'not a dump'); await assert.rejects(()=>runner.verifyBackup(path,receipt,identity,verify));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
