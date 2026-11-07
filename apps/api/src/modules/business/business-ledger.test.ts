import 'reflect-metadata';import assert from 'node:assert/strict';import test from 'node:test';import {PGlite} from '@electric-sql/pglite';import {DataSource} from 'typeorm';import {BusinessTransaction} from '../../entities/business-transaction.entity';import {BusinessLedgerService} from './business-ledger.service';
test('ledger uses SQL scope, whole-filter aggregates, stable 20/50/100 paging and Beijing collection dates',async()=>{
 const db=new PGlite(),ds=new DataSource({type:'postgres',entities:[BusinessTransaction]});await(ds as any).buildMetadatas();const real=ds.getRepository(BusinessTransaction),sqls:string[]=[];
 const wrap=(qb:any)=>{const clone=qb.clone.bind(qb);qb.clone=()=>wrap(clone());qb.getRawMany=async()=>{const[sql,params]=qb.getQueryAndParameters();sqls.push(sql);return(await db.query(sql,params)).rows};qb.getRawOne=async()=>(await qb.getRawMany())[0];return qb};const repo:any={manager:{connection:{query:async(sql:string,params:any[])=> (await db.query(sql,params)).rows}},createQueryBuilder:(alias:string)=>wrap(real.createQueryBuilder(alias))};
 try{await db.exec(`CREATE TABLE business_transactions(id int PRIMARY KEY,tenant_id int,community_id int,house_id int,created_by int,txn_no text,service_type text,status text,amount_cents int,payment_method text,external_sync_status text,created_at timestamptz,snapshot jsonb,quantity int,start_date date,end_date date);
 CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,shop_name text);CREATE TABLE buildings(id int,tenant_id int,community_id int,lane text,building_no text,road_name text);CREATE TABLE communities(id int,tenant_id int,name text);CREATE TABLE users(id int,tenant_id int,name text);INSERT INTO users VALUES(7,1,'Tester');
 INSERT INTO communities VALUES(10,1,'枫桦景苑二期');INSERT INTO buildings VALUES(8,1,10,'228','6','合成路');INSERT INTO houses VALUES(9,1,8,'502',NULL);
 INSERT INTO business_transactions SELECT n,1,10,NULL,7,'T'||n,'mis_property','paid',100,'cash','mis_queued','2026-11-06T01:00:00+08'::timestamptz,jsonb_build_object('house',jsonb_build_object('address',CASE WHEN n=1 THEN 'needle% road' ELSE '合成小区' END)),1 FROM generate_series(1,26)n;
 INSERT INTO business_transactions VALUES(100,1,20,NULL,7,'OUT','mis_property','paid',90000,'cash','synced','2026-11-06T01:00:00+08','{}',1),(101,2,10,NULL,7,'TENANT','mis_property','paid',90000,'cash','synced','2026-11-06T01:00:00+08','{}',1),(102,1,NULL,NULL,7,'NULL','mis_property','paid',90000,'cash','synced','2026-11-06T01:00:00+08','{}',1),(103,1,10,NULL,7,'PREVIOUS','mis_property','paid',90000,'cash','synced','2026-11-05T23:59:59+08','{}',1);`);
 const service=new BusinessLedgerService(repo),user:any={id:7,tenantId:1},access:any={scopeAll:false,communityIds:[10]},q={from:'2026-11-06',to:'2026-11-06'};
 await db.exec('UPDATE business_transactions SET house_id=9 WHERE id=1');assert.equal((await service.list({...q,q:'228/6/502'},user,access)).total,1,'复用全站地址识别，不按展示地址字符串猜匹配');
 const second=await service.list({...q,page:2},user,access);assert.equal(second.total,26);assert.equal(second.pageSize,20);assert.equal(second.rows.length,6);assert.equal(second.summary.netCents,2600);assert.deepEqual(second.rows.map((r:any)=>r.id),[6,5,4,3,2,1]);
 assert.equal((second.summary as any).paidCount,26);assert.deepEqual((second.summary as any).byService,[{serviceType:'mis_property',paidCents:2600,paidCount:26}]);
 const large=await service.list({...q,pageSize:50},user,access);assert.equal(large.rows.length,26);const beyond=await service.list({...q,page:999},user,access);assert.equal(beyond.page,2);assert.equal(beyond.rows.length,6);
 assert.equal((await service.list({...q,q:'needle%'},user,access)).total,1);assert.equal((await service.list(q,user,{scopeAll:true} as any)).total,28);
 assert.equal((await service.list(q,user,{scopeAll:false,communityIds:[]} as any)).total,0);await assert.rejects(()=>service.list(q,user),/授权/);await assert.rejects(()=>service.list({...q,pageSize:500},user,access),/分页/);await assert.rejects(()=>service.list({...q,communityId:20},user,access),/范围/);
 assert.ok(sqls.some(s=>/LIMIT 20/.test(s)));assert.ok(sqls.some(s=>/SUM/.test(s)&&!/LIMIT/.test(s)));
 // 停车续期明细：plateNo/原到期/新到期/操作人/收款方式中文；单 SQL 返回 snapshot，不额外查库
 await db.query(`INSERT INTO business_transactions(id,tenant_id,community_id,house_id,created_by,txn_no,service_type,status,amount_cents,payment_method,external_sync_status,created_at,snapshot,quantity,start_date,end_date) VALUES(200,1,10,NULL,7,'PKT','parking_monthly','paid',150000,'wechat','synced','2026-11-06T09:30:00+08',$1,12,'2026-11-01','2027-10-30')`,[JSON.stringify({parking:{plate:'TEST123',systems:[{label:'P1',previousEndDate:'2026-10-31'},{label:'P2',previousEndDate:'2026-11-30'}]},vehicle:{plateNo:'TEST123',validUntil:'2027-10-30'},estimate:{startDate:'2026-11-01',endDate:'2027-10-30',vehicleClass:'住户车-1'},ruleName:'住户车-1'})]);
 const parking:any=(await service.list({...q,serviceType:'parking_monthly'},user,access)).rows[0];
 assert.equal(parking.detail.plateNo,'TEST123');
 assert.equal(parking.detail.periodFrom,'2026-10-31','原到期日取多系统最早值');
 assert.equal(parking.detail.periodTo,'2027-10-30');
 assert.equal(parking.detail.operatorName,'Tester');
 assert.equal(parking.detail.paymentMethod,'微信');
 assert.equal(parking.detail.serviceType,'停车续期');
 assert.equal(parking.detail.amountCents,150000);
 assert.equal(parking.detail.extra.parkingSystems.length,2);
 assert.equal(parking.detail.extra.vehicleClass,'住户车-1');
 }finally{await db.close()}
});
