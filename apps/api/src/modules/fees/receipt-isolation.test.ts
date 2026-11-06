import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, FeeBill, FeeStandard, House, Community, User } from '../../entities';
import { FeesService } from './fees.service';
import { FeesController } from './fees.controller';
import { UserRole } from '../../common/enums';
import { todayInTz } from './report.util';


// 完全内存隔离：真实服务及TypeORM SQL，不读取.env或连接外部数据库。
async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({type:'postgres',entities,synchronize:false});
  await (ds as any).buildMetadatas();
  const runner = (connection:any, active=false):any => {
    const qr:any={connection:ds,isReleased:false,isTransactionActive:active,data:{},
      connect:async()=>{},release:async()=>{},
      query:async(sql:string,params:any[]=[],structured=false)=>{
        const out=await connection.query(sql,params);
        if(!structured)return out.rows;
        const result=new QueryResult();result.records=out.rows;result.raw=out.rows;result.affected=out.affectedRows;return result;
      },
    };
    qr.broadcaster=new Broadcaster(qr);
    qr.manager=ds.createEntityManager(qr);
    return qr;
  };
  (ds as any).isInitialized=true;
  ds.createQueryRunner=()=>runner(pg);
  ds.transaction=((callback:any)=>pg.transaction((tx:any)=>callback(runner(tx,true).manager))) as any;
  const table=ds.getMetadata(FeeBill);
  const columns=table.columns.map(c=>{
    const type=c.type===Number?'integer':c.type===String?'varchar':c.type;
    return `"${c.databaseName}" ${c.isPrimary?'serial PRIMARY KEY':type}${c.isNullable||c.isPrimary?'':' NOT NULL'}${c.databaseName==='created_at'||c.databaseName==='updated_at'?' DEFAULT now()':''}`;
  });
  await pg.exec(`CREATE TABLE fee_bills(${columns.join(',')});
    CREATE TABLE communities(id int,tenant_id int,name text);INSERT INTO communities VALUES(1,1,'测试公寓');
    CREATE TABLE buildings(id int,tenant_id int,community_id int,lane text,building_no text);INSERT INTO buildings VALUES(1,1,1,NULL,'A');
    CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,full_address text);INSERT INTO houses VALUES(1,1,1,'101','测试房');
    CREATE TABLE users(id int,tenant_id int,name text,phone text,house_id int,role text);`);
  const service=new FeesService(ds.getRepository(FeeBill),ds.getRepository(FeeStandard),ds.getRepository(House),ds.getRepository(Community),ds.getRepository(User),ds,{} as any);
  const user={id:1,tenantId:1,role:UserRole.STAFF};
  const insert=async(receiptNo:string,amount:number,paidAt:string,status='paid',remark:string|null=null,method='wechat')=>{
    await pg.query(`INSERT INTO fee_bills(tenant_id,community_id,house_id,owner_id,owner_name,fee_code,fee_name,period,amount_cents,status,paid_at,payment_method,receipt_no,source,remark,created_by,updated_by)
      VALUES(1,1,1,NULL,'测试住户','rent','房租','202610',$1,$2,$3,$4,$5,'manual',$6,1,1)`,[amount,status,paidAt,method,receiptNo,remark]);
  };
  await pg.exec(`INSERT INTO communities VALUES(2,1,'另一小区'),(3,2,'另一租户');
    INSERT INTO buildings VALUES(2,1,2,NULL,'B'),(3,2,3,NULL,'C');
    INSERT INTO houses VALUES(2,1,2,'201','另一户'),(3,2,3,'301','另一租户');`);
  const seed=async(receiptNo:string,houseId:number,amount:number,tenantId=1,communityId=houseId)=>{
    await pg.query(`INSERT INTO fee_bills(tenant_id,community_id,house_id,fee_code,fee_name,period,amount_cents,status,paid_at,payment_method,receipt_no,source,created_by,updated_by)
      VALUES($1,$2,$3,'rent','房租','202610',$4,'paid',$5,'cash',$6,'manual',1,1)`,
      [tenantId,communityId,houseId,amount,`${todayInTz()}T10:00:00+08:00`,receiptNo]);
  };
  return {pg,ds,service,user,insert,seed};
}

test('history明细严格限tenant + house + receipt，保留分页和金额',async()=>{
  const {pg,service,user,seed}=await fixture();
  try {
    await seed('REUSED',1,153);await seed('REUSED',2,900);await seed('REUSED',3,700,2);
    await seed('OTHER',1,25);
    const result=await service.cashierHistory(1,1,user);
    assert.equal(result.total,2);assert.equal(result.pageSize,10);
    const row=result.rows.find(r=>r.receiptNo==='REUSED')!;
    assert.equal(row.amountCents,153);
    assert.deepEqual(row.items.map(i=>i.amountCents),[153]);
    await assert.rejects(service.cashierHistory(1,1,user,{scopeAll:false,communityIds:[2]} as any),/范围/);
    const empty=await service.cashierHistory(1,2,user);
    assert.deepEqual(empty.rows,[]);assert.equal(empty.total,2);
  } finally {await pg.close();}
});

test('真实receiptItems的4万/8万条明细线性积累，不反复遍历已有结果',async()=>{
  for (const size of [40000,80000]) {
    const service=Object.create(FeesService.prototype) as any;
    const bills=Array.from({length:size},(_,id)=>({id,tenantId:1,houseId:1,receiptNo:'PERF',amountCents:1,quantity:null}));
    let calls=0;
    service.billRepo={find:async()=>{calls++;return bills;}};
    const mapped=new WeakSet<object>();let mappedCount=0;let copiedItems=0;
    const originalMap=service.mapReceiptItem;
    service.mapReceiptItem=(bill:any)=>{mappedCount++;const item=originalMap.call(service,bill);mapped.add(item);return item;};
    const iterator=Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator]=function(this:any[]){
      if(this.length && typeof this[0]==='object' && mapped.has(this[0])) copiedItems+=this.length;
      return iterator.call(this);
    };
    let result:any;
    try {result=await service.receiptItems(1,[{houseId:1,receiptNo:'PERF'}]);}
    finally {Array.prototype[Symbol.iterator]=iterator;}
    assert.equal(calls,1);assert.equal(mappedCount,size);
    assert.ok(copiedItems<=size,`size=${size}, copied accumulated items=${copiedItems}`);
    assert.equal(result.get('1:PERF').length,size);
    assert.equal(result.get('1:PERF')[size-1].id,size-1);
    console.log(`receiptItems size=${size} mapped=${mappedCount} copiedAccumulatedItems=${copiedItems}`);
    calls=0;assert.equal((await service.receiptItems(1,[])).size,0);assert.equal(calls,0);
  }
});

test('today按房屋分开历史同号，统计/分页/范围与明细一致',async()=>{
 const {pg,service,user,seed}=await fixture();
 try {
  await seed('SAME',1,100);await seed('SAME',2,900);await seed('SAME',3,700,2);
  await seed('REV',1,-100);
  await pg.exec("UPDATE fee_bills SET original_receipt_no='SAME',status='refunded' WHERE receipt_no='REV'; UPDATE fee_bills SET reversal_receipt_no='REV',status='refunded' WHERE receipt_no='SAME' AND house_id=1;");
  const all=await service.cashierToday({},user);
  assert.equal(all.total,3);assert.equal(all.totalCents,900);
  assert.deepEqual(all.rows.map(r=>[r.houseId,r.receiptNo,r.items.map(i=>i.amountCents)]),[[1,'SAME',[100]],[2,'SAME',[900]],[1,'REV',[-100]]]);
  assert.equal(all.rows[0].reversalReceiptNo,'REV');assert.equal(all.rows[2].originalReceiptNo,'SAME');
  const limited=await service.cashierToday({},user,{scopeAll:false,communityIds:[1]} as any);
  assert.equal(limited.total,2);assert.equal(limited.totalCents,0);
  assert.deepEqual(limited.rows.flatMap(r=>r.items.map(i=>i.amountCents)),[100,-100]);
  const page=await service.cashierToday({page:2,pageSize:1},user);
  assert.equal(page.total,3);assert.equal(page.totalCents,900);assert.equal(page.rows.length,1);
  assert.equal(page.rows[0].houseId,2);assert.deepEqual(page.rows[0].items.map(i=>i.amountCents),[900]);
  const empty=await service.cashierToday({},user,{scopeAll:false,communityIds:[]} as any);
  assert.deepEqual(empty,{rows:[],total:0,page:1,pageSize:20,totalCents:0});
 } finally {await pg.close();}
});

test('歧义历史收据拒绝详情/补打/退款，不能按首户放行或按scope截成半单',async()=>{
 const {pg,ds,service,user,seed}=await fixture();
 try {
  await seed('AMBIGUOUS',1,100);await seed('AMBIGUOUS',2,900);
  const before=await ds.getRepository(FeeBill).find();
  const controller=Object.create(FeesController.prototype) as any;controller.feesService=service;
  for(const access of [undefined,{scopeAll:false,communityIds:[1]},{scopeAll:false,communityIds:[2]}]) {
   await assert.rejects(service.cashierReceipt('AMBIGUOUS',user,access as any),/多.*房屋|无法唯一|歧义/);
   await assert.rejects(controller.reprintReceipt('AMBIGUOUS',user,access),/多.*房屋|无法唯一|歧义/);
   await assert.rejects(service.refundReceipt('AMBIGUOUS',{},user,access as any),/多.*房屋|无法唯一|歧义/);
  }
  assert.deepEqual(await ds.getRepository(FeeBill).find(),before);
  await assert.rejects(service.cashierReceipt('AMBIGUOUS',{...user,tenantId:2}),/不存在/);
 }finally{await pg.close();}
});

test('唯一房屋仍逐条核范围，正常收据及负数红冲不改金额和关联',async()=>{
 const {pg,service,user,seed}=await fixture();
 try {
  await seed('NORMAL',1,100);await seed('NORMAL',1,23);await seed('NORMAL',3,999,2);
  await seed('NEG',1,-123);
  await pg.exec("UPDATE fee_bills SET original_receipt_no='NORMAL',status='refunded' WHERE receipt_no='NEG'; UPDATE fee_bills SET reversal_receipt_no='NEG',status='refunded' WHERE receipt_no='NORMAL' AND tenant_id=1;");
  const normal=await service.cashierReceipt('NORMAL',user,{scopeAll:false,communityIds:[1]} as any);
  assert.equal(normal.amountCents,123);assert.equal(normal.reversalReceiptNo,'NEG');
  assert.deepEqual(normal.items.map(i=>i.amountCents),[100,23]);
  const negative=await service.cashierReceipt('NEG',user);
  assert.equal(negative.amountCents,-123);assert.equal(negative.originalReceiptNo,'NORMAL');
  await pg.exec("UPDATE fee_bills SET community_id=2 WHERE tenant_id=1 AND amount_cents=23");
  await assert.rejects(service.cashierReceipt('NORMAL',user,{scopeAll:false,communityIds:[1]} as any),/范围/);
 }finally{await pg.close();}
});

test('红冲事务锁后重读若出现跨户同号，必须在任何写入前拒绝',async()=>{
 const service=Object.create(FeesService.prototype) as any;
 const bill={id:1,tenantId:1,houseId:1,communityId:1,receiptNo:'RACE',status:'paid',amountCents:100};
 service.billRepo={find:async()=>[bill]};
 service.resolveHousePlace=async()=>({communityId:1});service.operatorName=async()=>'测试';
 let writes=0;
 service.dataSource={transaction:async(fn:any)=>fn({
  find:async()=>[bill,{...bill,id:2,houseId:2}],
  query:async()=>{writes++;throw new Error('不应进入写入路径');},
 })};
 await assert.rejects(service.refundReceipt('RACE',{}, {id:1,tenantId:1,role:UserRole.STAFF}),/多.*房屋|无法唯一|歧义/);
 assert.equal(writes,0);
});
