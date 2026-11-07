import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {DataSource, QueryResult} from 'typeorm';
import {Broadcaster} from 'typeorm/subscriber/Broadcaster';
import {MisFeesService} from './mis-fees.service';
import {MisCollectionPromise, MisCollectionHold, MisCollectionEvent, MisCollectionPrint} from '../../entities/mis-collection-followup.entity';
import {MisCollectionFollowups1794000000000} from '../../migrations/1794000000000-MisCollectionFollowups';
import {TenantConfig} from '../../entities/tenant-config.entity';
import {effectDay} from './mis-collection-effect';
/** Real TypeORM persistence against isolated PostgreSQL WASM; no AppModule, .env or business network. */
async function fixture(){
 const pg=new PGlite(),ds=new DataSource({type:'postgres',entities:[MisCollectionPromise,MisCollectionHold,MisCollectionEvent,MisCollectionPrint],synchronize:false});await (ds as any).buildMetadatas();
 const runner=(connection:any,active=false):any=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:active,data:{},connect:async()=>{},release:async()=>{},startTransaction:async()=>{await connection.query('BEGIN');qr.isTransactionActive=true},commitTransaction:async()=>{await connection.query('COMMIT');qr.isTransactionActive=false},rollbackTransaction:async()=>{await connection.query('ROLLBACK');qr.isTransactionActive=false},query:async(sql:string,params:any[]=[],structured=false)=>{const res=await connection.query(sql,params),out=new QueryResult();out.records=res.rows||[];out.affected=res.affectedRows??out.records.length;out.raw=/^\s*(UPDATE|DELETE)/i.test(sql)?[out.records,out.affected]:out.records;return structured?out:out.raw}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr};
 (ds as any).createQueryRunner=()=>runner(pg);Object.defineProperty(ds.driver,'isReturningSqlSupported',{value:()=>true});
 (ds.manager as any).transaction=(fn:any)=>pg.transaction(async tx=>fn(runner(tx,true).manager));
 const migration=new MisCollectionFollowups1794000000000();await migration.up({query:(sql:string)=>pg.query(sql)} as any);await migration.up({query:(sql:string)=>pg.query(sql)} as any);
 const today=effectDay(new Date()),houseKey='01:1:1',s:any=Object.create(MisFeesService.prototype);s.residentialScope=async(_q:any,u:any)=>{if(!u?.tenantId)throw Error('tenant required');return [{id:1,offices:['01']}]};
 s.batches={manager:ds.manager,findOne:async()=>({id:7,tenantId:1,communityIds:[1],purpose:'print',snapshot:{notices:[{houseKey,communityId:1,bills:Array.from({length:12},(_,i)=>({id:String(i+1),amountCents:100})),amountCents:1200}]}})};
 s.residential=async()=>({rows:Array.from({length:12},(_,i)=>({id:String(i+1),houseKey,amountCents:100}))});let paid:any[]=[];s.paidCollectionBills=async()=>paid;
 return {pg,ds,s,today,houseKey,setPaid:(n:number)=>{paid=Array.from({length:n},(_,i)=>({id:String(i+1),houseKey,amountCents:100,paidAt:today}))},user:{id:17,tenantId:1},access:{scopeAll:true}};
}
test('第4节真实TypeORM持久化、幂等、租户隔离、冻结与打印登记',async t=>{const f=await fixture(),{s,ds,pg,user,access,houseKey,today}=f;try{
 const promise={houseKey,action:'promise',promisedDate:today,promisedCents:1200,note:'isolated fixture promise',requestKey:'00000000-0000-4000-8000-000000000001'};
 await t.test('承诺与时间线同事务保存，原请求重试只产生一条',async()=>{const a=await s.recordCollectionFollowup(promise,user,access),b=await s.recordCollectionFollowup(promise,user,access);assert.equal(a.id,b.id);assert.equal(await ds.getRepository(MisCollectionPromise).count(),1);assert.equal(await ds.getRepository(MisCollectionEvent).count(),1);await assert.rejects(s.recordCollectionFollowup({...promise,note:'changed'},user,access),/请求标识已用于/)});
 await t.test('3/12期部分回款不能伪报履约；12/12才清除今日跟进',async()=>{f.setPaid(3);const a=await s.collectionFollowups({},user,access);assert.equal(a.promises[0].recoveredCents,300);assert.equal(a.promises[0].fulfilled,false);assert.equal(a.followupHouseholds,1);f.setPaid(12);const b=await s.collectionFollowups({},user,access);assert.equal(b.promises[0].fulfilled,true);assert.equal(b.followupHouseholds,0)});
 await t.test('不能跨office写跟进，不能跨tenant读他人跟进',async()=>{await assert.rejects(s.recordCollectionFollowup({...promise,houseKey:'02:1:1'},user,access),/不在当前授权范围/);const a=await s.collectionFollowups({}, {id:18,tenantId:2},access);assert.equal(a.promises.length,0);assert.equal(a.events.length,0)});
 let holdId=0;
 await t.test('冻结真实落库，解除须有原记录且留痕',async()=>{const e=await s.recordCollectionFollowup({houseKey,action:'hold',reason:'dispute',until:today,note:'isolated hold',requestKey:'00000000-0000-4000-8000-000000000002'},user,access);holdId=e.recordId;const preview=await s.previewCollection({filter:{},selection:'keys',houseKeys:[houseKey],purpose:'print'},user,access);assert.equal(preview.notices.length,0);assert.equal(preview.excludedHolds[0].reason,'dispute');assert.equal(preview.skipped.length,0);assert.equal((await s.activeCollectionHolds([houseKey],user,access)).length,1);await assert.rejects(s.recordCollectionFollowup({houseKey,action:'cancel_hold',recordId:999,note:'not present',requestKey:'00000000-0000-4000-8000-000000000003'},user,access),/原跟进不存在/);assert.equal(await ds.getRepository(MisCollectionEvent).count(),2)});
 await t.test('历史批次含冻结户时禁止登记打印',async()=>{await assert.rejects(s.registerCollectionPrint(7,{rowsPerPage:12,paper:'A5',pageCount:1,requestKey:'00000000-0000-4000-8000-000000000004'},user,access),/包含已冻结住户/);assert.equal(await ds.getRepository(MisCollectionPrint).count(),0)});
 await t.test('解除冻结后12期登记A5一页，回读与重试不重复',async()=>{await s.recordCollectionFollowup({houseKey,action:'cancel_hold',recordId:holdId,note:'resolved fixture',requestKey:'00000000-0000-4000-8000-000000000005'},user,access);assert.equal((await s.activeCollectionHolds([houseKey],user,access)).length,0);const dto={rowsPerPage:12,paper:'A5',pageCount:1,requestKey:'00000000-0000-4000-8000-000000000006'},a=await s.registerCollectionPrint(7,dto,user,access),b=await s.registerCollectionPrint(7,dto,user,access);assert.equal(a.id,b.id);assert.equal(a.operatorId,17);assert.equal(a.pageCount,1);const detail=await s.collectionDetail(7,user,access);assert.equal(detail.prints.length,1);assert.equal(detail.timeline.length,3)});
 await t.test('A4两联一页，页数伪造与复用标识改纸张都拒绝',async()=>{await assert.rejects(s.registerCollectionPrint(7,{paper:'A5',pageCount:99,requestKey:'00000000-0000-4000-8000-000000000007'},user,access),/页数与批次快照不一致/);const dto={rowsPerPage:12,paper:'A4',pageCount:1,requestKey:'00000000-0000-4000-8000-000000000008'},p=await s.registerCollectionPrint(7,dto,user,access);assert.equal(p.noticePageCount,1);assert.equal(p.pageCount,1);await assert.rejects(s.registerCollectionPrint(7,{...dto,rowsPerPage:12,paper:'A5',pageCount:1},user,access),/已用于另一打印请求/)});
 await t.test('旧8行客户端仍可登记12期两页',async()=>{const p=await s.registerCollectionPrint(7,{paper:'A5',pageCount:2,requestKey:'00000000-0000-4000-8000-000000000009'},user,access);assert.equal(p.pageCount,2);assert.equal(p.noticePageCount,2)});
 }finally{await pg.close()}});

test('跟进队列：人工事件按户聚合最近1条+次数，真实SQL不搬全量历史',async()=>{
 const f=await fixture(),{s,ds,pg,user,access}=f;
 try{
  const events=ds.getRepository(MisCollectionEvent),day=(n:number)=>new Date(Date.now()-n*86400000);
  const pendingRows:any[]=[
   {tenantId:1,communityId:1,houseKey:'01:1:1',action:'phone',note:'三周前电话',fingerprint:'f-1',requestKey:'r-1',createdBy:17,updatedBy:17,createdAt:day(30)},
   {tenantId:1,communityId:1,houseKey:'01:1:1',action:'promise',note:'承诺还款',fingerprint:'f-2',requestKey:'r-2',createdBy:17,updatedBy:17,createdAt:day(20)},
   {tenantId:1,communityId:1,houseKey:'01:1:1',action:'phone',note:'刚电话确认',fingerprint:'f-3',requestKey:'r-3',createdBy:17,updatedBy:17,createdAt:day(2)},
   {tenantId:1,communityId:1,houseKey:'01:1:1',action:'cancel_promise',note:'撤销不算人工跟进',fingerprint:'f-4',requestKey:'r-4',createdBy:17,updatedBy:17,createdAt:day(1)},
  ];
  await events.save(pendingRows as any);
  s.residential=async()=>({rows:[{houseKey:'01:1:1',address:'198弄1号1室',ownerName:'甲',amountCents:300000},{houseKey:'01:1:2',address:'198弄1号2室',ownerName:'乙',amountCents:300000}],total:2,amountCents:600000});
  const out=await s.collectionFollowups({},user,access);
  assert.equal(out.rows.length,2);
  const one=out.rows.find((r:any)=>r.houseKey==='01:1:1'),two=out.rows.find((r:any)=>r.houseKey==='01:1:2');
  assert.equal(one.contactCount,3,'撤销类事件不计入人工跟进次数');
  assert.equal(one.lastAction,'phone');
  assert.equal(one.lastNote,'刚电话确认');
  assert.equal(one.days,2);
  assert.equal(one.followupStatus,'contacted');
  assert.equal(two.never,true);assert.equal(two.contactCount,0);assert.equal(two.lastContactAt,null);
  assert.equal(out.stats.neverCount,1);assert.equal(out.stats.contactedCount,1);
 }finally{await pg.close()}
});

test('批次快照保存当前租户通知模板；租户未配模板时快照字段为 null（旧快照由打印端回退默认）',async()=>{
 const template={orgSuffix:'物业服务中心',signatureSuffix:'物业管理处',phone:'0571-88886666',serviceHours:'8:30–17:30 · 周一至周日',address:'合成路1号',bankHolder:'合成物业',bankName:'合成银行',bankAccount:'6222 0000 1111 2222',payMethods:'现金 / 微信 / 支付宝 / 刷卡',onlineTitle:'线上缴费已开通',onlineText:'微信扫码进入缴费页，选房号、勾账期即可付款。',notes:['扫码后请先核对房号与账期'],liability:'本单为欠费提醒，不作为收款凭证',showBatchNo:true,showPhone:true,qrImageUrl:'https://pay.example.com/qr.png'};
 const dto:any={filter:{},selection:'keys',houseKeys:['01:1:1'],purpose:'print',fingerprint:'a'.repeat(64),idempotencyKey:'00000000-0000-4000-8000-000000000011',confirmed:true};
 const user:any={id:7,tenantId:1},access:any={scopeAll:true};
 const build=(storedTemplate:any)=>{
  const s:any=Object.create(MisFeesService.prototype);
  s.residentialScope=async()=>[{id:1,name:'合成小区',offices:['01']}];
  s.previewCollection=async()=>({notices:[{houseKey:'01:1:1',communityId:1,bills:[{id:'1',amountCents:1000}],amountCents:1000}],totalCents:1000,billCount:1,fingerprint:'a'.repeat(64),queriedAt:'2026-11-07T00:00:00Z',sourceLabel:'fixture',skipped:[]});
  s.collectionRepo=(entity:any)=>{if(entity===TenantConfig)return {findOne:async()=>storedTemplate===undefined?null:{value:storedTemplate}};throw new Error('unexpected repository')};
  s.batches={findOne:async()=>null,create:(v:any)=>v,save:async(v:any)=>({...v,id:9})};
  return s;
 };
 const withTemplate:any=await build(template).createCollection(dto,user,access);
 assert.deepEqual(withTemplate.snapshot.noticeTemplate,template,'新批次快照必须原样保存当前租户模板');
 assert.equal(withTemplate.snapshot.notices.length,1,'模板随快照保存不改变原有通知快照');
 assert.equal(withTemplate.snapshot.fingerprint,'a'.repeat(64));
 const noTemplate:any=await build(undefined).createCollection(dto,user,access);
 assert.equal(noTemplate.snapshot.noticeTemplate,null,'租户没配模板时快照写 null；旧快照本身就是没有该字段，打印端按 DEFAULT 回退');
});
