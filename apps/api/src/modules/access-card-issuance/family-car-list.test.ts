import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, EntitySchema } from 'typeorm';
import { PGlite } from '@electric-sql/pglite';
import { FamilyCarService } from './family-car.service';

/** Real service and TypeORM-generated SELECT executed by isolated PostgreSQL. No AppModule/env/network. */
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
 const columns:any={id:{type:Number,primary:true},tenantId:{type:Number,name:'tenant_id'},houseId:{type:Number,name:'house_id'},lane:{type:String},buildingNo:{type:String,name:'building_no'},roomNo:{type:String,name:'room_no'},status:{type:String},plate:{type:String},ownerName:{type:String,name:'owner_name'},carOwnerName:{type:String,name:'car_owner_name'},carOwnerPhone:{type:String,name:'car_owner_phone'},ownerPhone:{type:String,name:'owner_phone'},remark:{type:String}};
 const schema=new EntitySchema({name:'FamilyListRow',tableName:'family_cars',columns});const ds=new DataSource({type:'postgres',entities:[schema]});await (ds as any).buildMetadatas();let executions=0;
 const service=Object.create(FamilyCarService.prototype);Object.assign(service,{view:(row:any)=>row,repo:{createQueryBuilder:()=>{const qb:any=ds.getRepository(schema).createQueryBuilder('fc');qb.getMany=async()=>{executions++;const [sql,params]=qb.getQueryAndParameters();const result=await db.query(sql,params);return result.rows.map((raw:any)=>Object.fromEntries(Object.entries(columns).map(([key,c]:any)=>[key,raw['fc_'+(c.name||key)]])));};return qb;}}});
 return {service,executions:()=>executions};
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
