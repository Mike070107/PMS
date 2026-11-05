import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, EntitySchema, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { PGlite } from '@electric-sql/pglite';
import { FamilyCarService } from './family-car.service';
import { FamilyCarController } from './family-car.controller';

test('控制器透传分页，服务端count及offset/limit返回第二页且只映射当页', async t => {
 const h=await harness(t);const mapped:number[]=[];h.service.view=(r:any)=>{mapped.push(r.id);return r;};
 const c=new FamilyCarController(h.service);const r:any=await c.list({page:'2',pageSize:'2'} as any,{tenantId:1} as any,{scopeAll:true} as any);
 assert.deepEqual(r.rows.map((x:any)=>x.id),[2,1]);assert.equal(r.total,7);assert.equal(r.page,2);assert.equal(r.pageSize,2);assert.deepEqual(mapped,[2,1]);assert.equal(h.executions(),2);assert.match(h.statements[0],/COUNT\(/);assert.match(h.statements[1],/LIMIT 2 OFFSET 2/);
 const last:any=await h.service.list({page:'999',pageSize:'2'} as any,{tenantId:1} as any,{scopeAll:true} as any);assert.equal(last.page,4);assert.deepEqual(last.rows.map((x:any)=>x.id),[7]);
 const old:any=await h.service.list({}, {tenantId:1} as any,{scopeAll:true} as any);assert.equal(old.rows.length,7);assert.deepEqual(Object.keys(old).sort(),['rows','today']);
});

/** Real service and TypeORM-generated SELECT executed by isolated PostgreSQL. No AppModule/env/network. */
test('分页安全整数默认值和上限，空数据及空范围固定page=1',async t=>{
 const h=await harness(t);const user:any={tenantId:1};const access:any={scopeAll:true};
 for(const bad of ['0','-1','1.5','1e2','Infinity','9007199254740992',[],{}]){
  const r:any=await h.service.list({page:bad,pageSize:bad} as any,user,access);assert.equal(r.page,1);assert.equal(r.pageSize,20);assert.equal(r.total,7);
 }
 for(const size of ['20','50','100','999']){const r:any=await h.service.list({pageSize:size} as any,user,access);assert.equal(r.pageSize,Math.min(Number(size),100));assert.equal(r.page,1);}
 const none:any=await h.service.list({page:'9',q:'NOT_FOUND'} as any,user,access);assert.equal(none.total,0);assert.equal(none.page,1);assert.deepEqual(none.rows,[]);
 const before=h.executions();const empty:any=await h.service.list({page:'9',pageSize:'50'} as any,user,{scopeAll:false,communityIds:[]} as any);assert.deepEqual(empty,{rows:[],today:empty.today,total:0,page:1,pageSize:50});assert.equal(h.executions(),before);
});
test('状态精确过滤及400校验，分页count与租户小区弄号搜索保持同范围',async t=>{
 const h=await harness(t);await h.db.exec("INSERT INTO family_cars VALUES(10,1,101,'198','1','3','returned','RETURNED','','','','','')");
 const user:any={tenantId:1};const access:any={scopeAll:false,communityIds:[17]};
 const call=(q:any,a=access)=>h.service.list(q,user,a) as Promise<any>;
 const expired=await call({status:'expired',page:1,pageSize:20});assert.deepEqual(expired.rows.map((r:any)=>r.id),[4]);assert.equal(expired.total,1);
 for(const [status,id] of [['returned',10],['void',9]]){const r=await call({status,page:1});assert.equal(r.total,1);assert.deepEqual(r.rows.map((x:any)=>x.id),[id]);}
 for(const status of ['upload','office','manager','opening'])assert.equal((await call({status,page:1})).total,0);
 const all=await call({status:'all',lane:'198',q:'SYNTH',page:2,pageSize:2});assert.equal(all.total,6);assert.deepEqual(all.rows.map((r:any)=>r.id),[2,1]);
 assert.equal((await call({status:'all',lane:'228',page:1})).total,0);
 assert.equal((await call({status:'all',page:1})).total,8);
 for(const invalid of ['bogus','__proto__','toString',['active'],{}]) {
  for(const a of [access,{scopeAll:false,communityIds:[]}])await assert.rejects(()=>call({status:invalid,page:1},a),(e:any)=>e.getStatus()===400);
 }
});
test('列表真实view仅给fileCount，不映射或签名附件，不调用详情同步',async t=>{
 const h=await harness(t);delete h.service.view;
 const file={objectKey:'SYNTHETIC_SECRET_KEY',fileName:'SYNTHETIC_SECRET_NAME',contentType:'application/pdf',source:'office',uploadedAt:'2026-01-01'};
 await h.db.query('UPDATE family_cars SET files=$1 WHERE id=2',[JSON.stringify([file])]);
 h.service.materialFiles=()=>assert.fail('列表不得映射附件');h.service.storage=new Proxy({}, {get:()=>()=>assert.fail('列表不得签名附件')});h.service.sync=()=>assert.fail('列表不得同步');
 const r=await h.service.list({page:2,pageSize:2},{tenantId:1},{scopeAll:true});assert.deepEqual(r.rows.map((x:any)=>x.fileCount),[1,0]);assert.ok(r.rows.every((x:any)=>!('files' in x)));assert.doesNotMatch(JSON.stringify(r),/SYNTHETIC_SECRET/);
});
async function harness(t:any){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE family_cars(id int PRIMARY KEY,tenant_id int,house_id int,lane text,building_no text,room_no text,status text,plate text,owner_name text,car_owner_name text,car_owner_phone text,owner_phone text,remark text);CREATE TABLE houses(id int,building_id int);CREATE TABLE buildings(id int,community_id int);
 INSERT INTO buildings VALUES(1,17),(2,18);INSERT INTO houses VALUES(101,1),(102,2);
 INSERT INTO family_cars VALUES
 (1,1,101,'198','10','101','active','SYNTH1','','','','',''),
 (2,1,101,'198','2','201','active','SYNTH2','','','','',''),
 (3,1,101,'198','商铺','A01','active','SYNTH3','','','','',''),
 (4,1,101,'198','1','10','expired','SYNTH4','','','','',''),
 (5,1,101,'198','1','2','active','SYNTH5','','','','',''),
 (6,1,101,'198','999999999999999999999999','1','active','SYNTH6','','','','',''),
 (7,1,102,'228','1','1','active','SYNTH7','','','','',''),
 (8,2,101,'198','1','1','active','OTHER_TENANT','','','','',''),
 (9,1,101,'198','1','1','void','VOID','','','','','');`);
 const columns:any={files:{type:'jsonb'},id:{type:Number,primary:true},tenantId:{type:Number,name:'tenant_id'},houseId:{type:Number,name:'house_id'},lane:{type:String},buildingNo:{type:String,name:'building_no'},roomNo:{type:String,name:'room_no'},status:{type:String},plate:{type:String},ownerName:{type:String,name:'owner_name'},carOwnerName:{type:String,name:'car_owner_name'},carOwnerPhone:{type:String,name:'car_owner_phone'},ownerPhone:{type:String,name:'owner_phone'},remark:{type:String}};
 const schema=new EntitySchema({name:'FamilyListRow',tableName:'family_cars',columns});
 await db.exec("ALTER TABLE family_cars ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb");
 const ds=new DataSource({type:'postgres',entities:[schema]});await (ds as any).buildMetadatas();let executions=0;
 const statements:string[]=[];
 ds.createQueryRunner=(()=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:false,data:{},connect:async()=>{},release:async()=>{},query:async(sql:string,params:any[]=[],structured=false)=>{executions++;statements.push(sql);const out=await db.query(sql,params);if(!structured)return out.rows;const result=new QueryResult();result.records=out.rows;result.raw=out.rows;result.affected=out.affectedRows;return result;}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr;}) as any;
 const service:any=Object.create(FamilyCarService.prototype);Object.assign(service,{view:(row:any)=>row,repo:ds.getRepository(schema)});
 return {service,db,statements,executions:()=>executions};
}
test('亲情车真实查询包含文字楼栋及超大数字时仍可返回，按数字楼栋和室号自然排序',async t=>{
 const {service}=await harness(t);const r=await service.list({}, {tenantId:1} as any,{scopeAll:true} as any);
 assert.equal(r.rows.length,7);assert.deepEqual(r.rows.slice(0,4).map((x:any)=>x.id),[5,4,2,1]);assert.ok(r.rows.some((x:any)=>x.id===3));assert.ok(r.rows.some((x:any)=>x.id===6));
 assert.ok(!r.rows.some((x:any)=>[8,9].includes(x.id)));
});
test('自然排序不放宽租户、小区、查询词或作废过滤；空范围不执行SQL',async t=>{
 const h=await harness(t);const r=await h.service.list({}, {tenantId:1} as any,{scopeAll:false,communityIds:[17]} as any);assert.equal(r.rows.length,6);assert.ok(!r.rows.some((x:any)=>[7,8,9].includes(x.id)));
 const q=await h.service.list({q:'SYNTH3'}, {tenantId:1} as any,{scopeAll:true} as any);assert.deepEqual(q.rows.map((x:any)=>x.id),[3]);
 const before=h.executions();const empty=await h.service.list({}, {tenantId:1} as any,{scopeAll:false,communityIds:[]} as any);assert.deepEqual(empty.rows,[]);assert.equal(h.executions(),before);
 const all=await h.service.list({status:'all'}, {tenantId:1} as any,{scopeAll:true} as any);assert.equal(all.rows.length,8);assert.ok(all.rows.some((x:any)=>x.id===9));
});
