import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MisFeesService } from './mis-fees.service';
import { MisCollectionEvent, MisCollectionHold, MisCollectionPromise } from '../../entities/mis-collection-followup.entity';
import { TenantConfig } from '../../entities/tenant-config.entity';
test('第4.1节提供催收效果只读入口，不能以现有收费总览替代',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.collectionEffects,'function');});

test('followup records must persist and frozen households must be excluded by preview',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.recordCollectionFollowup,'function');assert.equal(typeof s.collectionFollowups,'function');});

test('print registration requires a persisted API before window print',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.registerCollectionPrint,'function');});

test('SMS readiness reason comes from existing settings rather than generic channel text',async()=>{const s:any=Object.create(MisFeesService.prototype);s.configured=()=>true;s.scope=async()=>[{id:1,name:'fixture',offices:['01']}];s.read=async()=>({recordset:[]});s.smsSettings={readiness:async()=>({configured:false,enabled:false,canSend:false,reason:'fixture-template-not-approved'})};const out=await s.metadata({id:1,tenantId:1},{scopeAll:true} as any);assert.equal(out.smsReadiness?.reason,'fixture-template-not-approved');});

test('effect rejects missing snapshot rather than publishing a zero total',async()=>{const s:any=Object.create(MisFeesService.prototype);s.residentialScope=async()=>[{id:1}];const qb:any={where:()=>qb,andWhere:()=>qb,orderBy:()=>qb,take:()=>qb,getMany:async()=>[{id:1,createdAt:new Date(),communityIds:[1],snapshot:{}}]};s.batches={createQueryBuilder:()=>qb};await assert.rejects(s.collectionEffects({}, {id:1,tenantId:1},{}),/snapshot|\u5feb\u7167/i)});

test('跟进提醒：按价值排序的待办队列（门槛/状态/搜索/排序/分页，只认人工事件）',async()=>{
 const day=n=>new Date(Date.now()-n*86400000),long='x'.repeat(45);
 const rows=[
  {houseKey:'01:1:1',address:'合成花园1栋101室',ownerName:'张三',amountCents:500000},
  {houseKey:'01:1:2',address:'合成花园1栋102室',ownerName:'李四',amountCents:400000},
  {houseKey:'01:1:3',address:'合成花园3栋301室',ownerName:'王五',amountCents:300000},
  {houseKey:'01:1:4',address:'合成花园1栋104室',ownerName:'赵六',amountCents:50000},
 ];
 const events=[
  {houseKey:'01:1:2',createdAt:day(2),action:'phone',note:long},
  {houseKey:'01:1:2',createdAt:day(3),action:'phone',note:'第一次电话'},
  {houseKey:'01:1:3',createdAt:day(30),action:'hold',note:'费用争议已登记'},
  {houseKey:'01:1:1',createdAt:day(1),action:'cancel_promise',note:'撤销不是人工跟进'},
 ];
 let captured:any=null;
 const s:any=Object.create(MisFeesService.prototype);
 s.residentialScope=async()=>[{id:1,offices:['01']}];
 s.residential=async(q:any)=>{assert.equal(q._aging,false,'队列必须跳过账龄全量扫描');const total=rows.reduce((sum,r)=>sum+r.amountCents,0);return {rows,total:rows.length,amountCents:total}};
 s.collectionRepo=(entity:any)=>{
  if(entity===MisCollectionPromise||entity===MisCollectionHold)return {find:async()=>[]};
  if(entity===MisCollectionEvent)return {find:async()=>[],manager:{query:async(sql:string,params:any[])=>{
   captured={sql,params};const [tenantId,keys,actions]=params;
   const grouped=new Map<string,any>();
   for(const e of events.filter(e=>keys.includes(e.houseKey)&&actions.includes(e.action))){
    const cur=grouped.get(e.houseKey);
    if(!cur||e.createdAt>cur.last_at)grouped.set(e.houseKey,{house_key:e.houseKey,contact_count:(cur?.contact_count||0)+1,last_at:e.createdAt,last_action:e.action,last_note:e.note});
    else cur.contact_count+=1;
   }
   return [...grouped.values()];
  }}};
  if(entity===TenantConfig)return {findOne:async()=>({value:{amountCents:100000,inactiveDays:7,enabled:true}})};
  throw new Error('unexpected repository');
 };
 const user:any={id:1,tenantId:1},access:any={scopeAll:true};
 const base=await s.collectionFollowups({},user,access);
 assert.equal(captured.params[0],1,'事件聚合必须带租户条件');
 assert.deepEqual([...captured.params[1]].sort(),rows.map(r=>r.houseKey).sort(),'事件聚合只查本次扫描到的责任对象');
 assert.deepEqual(captured.params[2],['phone','promise','hold'],'打印/短信/撤销类事件不能算人工跟进');
 assert.match(captured.sql,/GROUP BY house_key/,'按户聚合成最近1条+次数，不搬全量历史事件');
 assert.equal(base.total,3,'金额门槛以下的户不进队列');
 assert.equal(base.totalAmountCents,1200000);
 assert.equal(base.stats.hitCount,3);
 assert.equal(base.stats.avgAmountCents,312500,'平均值按全部待缴户，不是命中户');
 assert.equal(base.stats.neverCount,1);assert.equal(base.stats.overdueCount,2);assert.equal(base.stats.contactedCount,1);
 assert.equal(base.followupHouseholds,2,'今日待跟进只算从未/超期，不含已跟进');
 assert.deepEqual(base.rows.map((r:any)=>r.houseKey),['01:1:1','01:1:2','01:1:3'],'默认按金额降序');
 assert.equal(base.rows[0].never,true);assert.equal(base.rows[0].lastAction,null);assert.equal(base.rows[0].contactCount,0);assert.equal(base.rows[0].ownerName,'张三');
 assert.equal(base.rows[1].followupStatus,'contacted');assert.equal(base.rows[1].lastAction,'phone');assert.equal(base.rows[1].contactCount,2);
 assert.equal(base.rows[1].lastNote,'x'.repeat(40)+'…','备注截断40字');
 assert.equal(base.rows[2].followupStatus,'overdue');assert.equal(base.rows[2].lastAction,'hold');assert.equal(base.rows[2].days,30);
 assert.deepEqual(base.largeInactive.map((r:any)=>r.houseKey),['01:1:1','01:1:3']);
 const never=await s.collectionFollowups({status:'never'},user,access);assert.deepEqual(never.rows.map((r:any)=>r.houseKey),['01:1:1']);
 const overdue=await s.collectionFollowups({status:'overdue'},user,access);assert.deepEqual(overdue.rows.map((r:any)=>r.houseKey),['01:1:1','01:1:3']);
 const contacted=await s.collectionFollowups({status:'contacted'},user,access);assert.deepEqual(contacted.rows.map((r:any)=>r.houseKey),['01:1:2']);
 const recent=await s.collectionFollowups({sort:'recent'},user,access);assert.deepEqual(recent.rows.map((r:any)=>r.houseKey),['01:1:2','01:1:3','01:1:1'],'recent 按上次跟进倒序且 never 最后');
 const searched=await s.collectionFollowups({q:'301'},user,access);assert.deepEqual(searched.rows.map((r:any)=>r.houseKey),['01:1:3'],'可按房号/地址搜索');
 const byOwner=await s.collectionFollowups({q:'李四'},user,access);assert.deepEqual(byOwner.rows.map((r:any)=>r.houseKey),['01:1:2']);
 const page1=await s.collectionFollowups({page:1,pageSize:2},user,access),page2=await s.collectionFollowups({page:2,pageSize:2},user,access);
 assert.deepEqual(page1.rows.map((r:any)=>r.houseKey),['01:1:1','01:1:2']);assert.equal(page1.total,3,'分页不改变 total');assert.deepEqual(page2.rows.map((r:any)=>r.houseKey),['01:1:3']);
 assert.equal((await s.collectionFollowups({status:'contacted',q:'301'},user,access)).total,0,'筛选与搜索可叠加');
 await assert.rejects(s.collectionFollowups({status:'bogus' as any},user,access),/筛选/);
 await assert.rejects(s.collectionFollowups({sort:'bogus' as any},user,access),/排序/);
 await assert.rejects(s.collectionFollowups({pageSize:0},user,access),/分页/);
});

