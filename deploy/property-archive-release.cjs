'use strict';
// Explicit one-off production migration. Never loaded by the API or run on startup.
const fs=require('node:fs'),path=require('node:path');
async function applyClassification(db, scope) {
  if (!Number.isInteger(scope.tenantId)||scope.tenantId<=0) throw Error('租户范围无效');
  const plan=[...scope.apartments.map(x=>({...x,type:'apartment'})),...scope.communities.map(x=>({...x,type:'community'}))];
  if (!plan.length||new Set(plan.map(x=>x.id)).size!==plan.length||plan.some(x=>!Number.isInteger(x.id)||x.id<=0||!x.name)) throw Error('分类计划无效');
  const found=await db.query('SELECT id,name,community_type FROM communities WHERE tenant_id=$1 AND id=ANY($2::int[]) FOR UPDATE',[scope.tenantId,plan.map(x=>x.id)]);
  if (found.rows.length!==plan.length||plan.some(p=>!found.rows.some(r=>Number(r.id)===p.id&&r.name===p.name))) throw Error('批准的主数据不一致，拒绝整批分类');
  const changed=[];
  for(const p of plan){
    const result=await db.query('UPDATE communities SET community_type=$4 WHERE tenant_id=$1 AND id=$2 AND name=$3 AND community_type IS DISTINCT FROM $4 RETURNING id,name,community_type',[scope.tenantId,p.id,p.name,p.type]);
    changed.push(...result.rows);
  }
  const verified=await db.query('SELECT id,name,community_type FROM communities WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id',[scope.tenantId,plan.map(x=>x.id)]);
  if(plan.some(p=>!verified.rows.some(r=>Number(r.id)===p.id&&r.community_type===p.type)))throw Error('分类回读不一致');
  return {changed,verified:verified.rows};
}
module.exports={applyClassification};
if(require.main===module) main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||'MIGRATION_FAILED',reason:e.safeReason||'迁移未确认成功；检查审计与正式库，不自动重试'}));process.exitCode=1;});
async function main(){
 const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
 for(const k of ['--api-root','--migration-json','--scope','--backup','--audit-file']) if(!args.includes(k)||!value(k)) throw Error('Missing explicit input');
 if(!args.includes('--apply')) throw Error('Explicit --apply required');
 const root=value('--api-root'),backup=value('--backup'),audit=value('--audit-file');
 if(fs.existsSync(audit)) throw Error('Audit already exists; inspect prior state');
 const fd=fs.openSync(backup,'r'),magic=Buffer.alloc(5);try{fs.readSync(fd,magic,0,5,0);}finally{fs.closeSync(fd);}
 if(magic.toString()!=='PGDMP'||fs.statSync(backup).size<=5) throw Error('Valid custom PostgreSQL backup required');
 const migration=JSON.parse(fs.readFileSync(value('--migration-json'),'utf8')),scope=JSON.parse(fs.readFileSync(value('--scope'),'utf8'));
 if(!/^[a-f0-9]{64}$/.test(migration.sourceSha256)||!Array.isArray(migration.statements)||!migration.statements.length) throw Error('Invalid migration manifest');
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync(path.join(root,'.env')));
 const {Client}=require(path.join(root,'node_modules/pg'));
 const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),user:env.DB_USER,password:env.DB_PASS,database:env.DB_NAME});
 let committed=false;
 try{
  await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='60s'");
  // Confirm the approved IDs and names before any DDL or data backfill.
  const expected=[...scope.apartments,...scope.communities];
  const before=await db.query('SELECT id,name FROM communities WHERE tenant_id=$1 AND id=ANY($2::int[]) FOR UPDATE',[scope.tenantId,expected.map(x=>x.id)]);
  if(before.rows.length!==expected.length||expected.some(p=>!before.rows.some(r=>Number(r.id)===p.id&&r.name===p.name)))throw Error('Approved master data changed');
  for(const sql of migration.statements)await db.query(sql);
  const result=await applyClassification(db,scope);
  await db.query('COMMIT');committed=true;
  const evidence={ok:true,committed,backup,migrationSourceSha256:migration.sourceSha256,at:new Date().toISOString(),...result};
  fs.writeFileSync(audit,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(evidence));
 }catch(e){if(!committed)await db.query('ROLLBACK').catch(()=>{});else console.error(JSON.stringify({committed:true,resultUnknownToCaller:true}));throw e;}
 finally{await db.end();}
}
