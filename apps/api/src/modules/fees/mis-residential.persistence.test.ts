import { MisCollectionPromise, MisCollectionHold, MisCollectionEvent, MisCollectionPrint } from '../../entities/mis-collection-followup.entity';
import { MisCollectionFollowups1794000000000 } from '../../migrations/1794000000000-MisCollectionFollowups';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';
import { MisCollectionBatches1793800000000 } from '../../migrations/1793800000000-MisCollectionBatches';
import { MisFeesService } from './mis-fees.service';
import { TenantConfig } from '../../entities/tenant-config.entity';
import { CollectionSmsService } from '../settings/collection-sms.service';
async function fixture(){const pg=new PGlite(),ds=new DataSource({type:'postgres',entities:[MisCollectionBatch,TenantConfig,MisCollectionPromise,MisCollectionHold,MisCollectionEvent,MisCollectionPrint],synchronize:false});await (ds as any).buildMetadatas();const runner=():any=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:false,data:{},connect:async()=>{},release:async()=>{},query:async(sql:string,params:any[]=[],structured=false)=>{const out=await pg.query(sql,params);if(!structured)return out.rows;const r=new QueryResult();r.records=out.rows;r.raw=out.rows;r.affected=out.affectedRows;return r;}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);qr.startTransaction=async()=>{await pg.exec('BEGIN');qr.isTransactionActive=true};qr.commitTransaction=async()=>{await pg.exec('COMMIT');qr.isTransactionActive=false};qr.rollbackTransaction=async()=>{await pg.exec('ROLLBACK');qr.isTransactionActive=false};return qr};(ds as any).isInitialized=true;ds.createQueryRunner=runner;await new MisCollectionFollowups1794000000000().up({query:(sql:string)=>pg.query(sql)} as any);const migration=new MisCollectionBatches1793800000000();await migration.up({query:(s:string)=>pg.query(s)} as any);await migration.up({query:(s:string)=>pg.query(s)} as any);await pg.exec(`CREATE TABLE tenant_configs (id serial PRIMARY KEY,tenant_id int NOT NULL,key varchar(60) NOT NULL,value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by int,updated_by int,UNIQUE(tenant_id,key))`);return {pg,repo:ds.getRepository(MisCollectionBatch),smsRepo:ds.getRepository(TenantConfig)}}
test('真实TypeORM保存/刷新历史、幂等重放和租户/小区范围隔离',async()=>{const f=await fixture(),old=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';try{const communities:any={find:async()=>[{id:1,name:'枫桦景苑一期'},{id:2,name:'枫桦景苑二期'}]};const make=()=>{const s:any=new MisFeesService(communities,{} as any,f.repo);s.read=async()=>({recordsets:[[{houseKey:'01:1:2',id:'11',officeCode:'01',address:'198弄1号2室',ownerName:'隔离测试户',phone:'13800000000',period:'202601',feeCode:'01',feeName:'物业费',amount:'10.00',updatedAt:'2026-11-04'}]]});return s};const s=make(),user:any={id:7,tenantId:1},access:any={scopeAll:true},dto:any={filter:{},selection:'keys',houseKeys:['01:1:2'],purpose:'print'};const preview=await s.previewCollection(dto,user,access);const body={...dto,fingerprint:preview.fingerprint,idempotencyKey:'6ba3d184-5a7b-4989-bb58-a59069385a69',confirmed:true};const first=await s.createCollection(body,user,access),second=await make().createCollection(body,user,access);assert.equal(first.id,second.id);assert.equal(await f.repo.count(),1);const history=await make().collectionHistory({},{...user},{scopeAll:false,communityIds:[1]});assert.equal(history.total,1);assert.equal(history.rows[0].houseCount,1);const denied=await make().collectionHistory({},user,{scopeAll:false,communityIds:[2]});assert.equal(denied.total,0);await assert.rejects(make().collectionDetail(first.id,user,{scopeAll:false,communityIds:[2]}),/范围/);await assert.rejects(make().collectionDetail(first.id,{id:8,tenantId:2},access),/范围/);const detail=await make().collectionDetail(first.id,user,access);assert.equal((detail.snapshot as any).notices[0].amountCents,1000);assert.equal(detail.status,'generated');assert.ok(!JSON.stringify(detail).includes('13800000000'));}finally{if(old===undefined)delete process.env.MIS_FEES_TENANT_ID;else process.env.MIS_FEES_TENANT_ID=old;await f.pg.close()}});

for(const scenario of ['rotate','clear','insert'] as const)test(`短信配置真实TypeORM/PGlite并发${scenario}不丢更新或复活凭据`,async()=>{
 const f=await fixture(),old=process.env.SETTINGS_ENCRYPTION_KEY;process.env.SETTINGS_ENCRYPTION_KEY='synthetic-persistence-master';
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);let captured!:()=>void;const read=new Promise<void>(r=>captured=r);
 try{
  const user:any={id:1,tenantId:1},a=new CollectionSmsService(f.smsRepo);
  if(scenario!=='insert')await a.save({accessKeyId:'synthetic-old-id',accessKeySecret:'synthetic-old-secret'},user);
  await a.save({startHour:10},{...user,tenantId:2});
  let first=true;const repo=new Proxy(f.smsRepo,{get(target,key){if(key==='findOne')return async(options:any)=>{const row=await target.findOne(options);if(first){first=false;captured();await wait}return row};const v=(target as any)[key];return typeof v==='function'?v.bind(target):v}});
  const b=new CollectionSmsService(repo),pending=b.save({endHour:20,accessKeyId:'',accessKeySecret:''},user);await read;
  await a.save(scenario==='clear'?{clearCredentials:true}:{accessKeyId:'synthetic-new-id',accessKeySecret:'synthetic-new-secret'},user);release();await pending;
  const out=await a.get(user);assert.equal(out.endHour,20);assert.equal((await a.get({...user,tenantId:2})).startHour,10);
  if(scenario==='clear'){assert.equal(out.hasAccessKeyId,false,'并发留空更新不得复活已清除密钥');assert.equal(out.hasAccessKeySecret,false)}
  else {assert.ok((await a.credentials(1)).accessKeyId==='synthetic-new-id','并发留空更新不得覆写新密钥');assert.ok((await a.credentials(1)).accessKeySecret==='synthetic-new-secret')}
  assert.equal((await a.readiness(1)).canSend,false);assert.equal(await f.smsRepo.count({where:{tenantId:1}}),1);
 }finally{release();if(old===undefined)delete process.env.SETTINGS_ENCRYPTION_KEY;else process.env.SETTINGS_ENCRYPTION_KEY=old;await f.pg.close()}
});
