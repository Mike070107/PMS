import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, EntitySchema, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { PGlite } from '@electric-sql/pglite';
import { Reflector } from '@nestjs/core';
import { FamilyCarService } from './family-car.service';
import { FamilyCarController } from './family-car.controller';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';

async function setup(t:any) {
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE family_cars(id int PRIMARY KEY,tenant_id int,house_id int,plate text,files jsonb);CREATE TABLE houses(id int PRIMARY KEY,building_id int);CREATE TABLE buildings(id int PRIMARY KEY,community_id int);INSERT INTO houses VALUES(101,1),(102,2);INSERT INTO buildings VALUES(1,17),(2,18);`);
 const file={objectKey:'family-cars/合成 proof.pdf',fileName:'proof.pdf',contentType:'application/pdf',source:'office',uploadedAt:'2026-01-01T00:00:00.000Z'};
 await db.query('INSERT INTO family_cars VALUES (1,1,101,$1,$2),(2,1,102,$1,$2),(3,2,101,$1,$2)', ['SYNTHETIC',JSON.stringify([file])]);
 const carColumns:any={id:{type:Number,primary:true},tenantId:{type:Number,name:'tenant_id'},houseId:{type:Number,name:'house_id'},plate:{type:String},files:{type:'jsonb'}};
 const defs:any[]=[['Car','family_cars',carColumns],['House','houses',{id:{type:Number,primary:true},buildingId:{type:Number,name:'building_id'}}],['Building','buildings',{id:{type:Number,primary:true},communityId:{type:Number,name:'community_id'}}]];
 const schemas=defs.map(([name,tableName,columns])=>new EntitySchema({name,tableName,columns}));
 const ds=new DataSource({type:'postgres',entities:schemas});await (ds as any).buildMetadatas();
 ds.createQueryRunner=(()=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:false,data:{},connect:async()=>{},release:async()=>{},query:async(sql:string,params:any[]=[],structured=false)=>{const out=await db.query(sql,params);if(!structured)return out.rows;const result=new QueryResult();result.records=out.rows;result.raw=out.rows;result.affected=out.affectedRows;return result;}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr;}) as any;
 const repo=(i:number)=>ds.getRepository(schemas[i]);
 const calls:string[]=[];const forbidden=new Proxy({}, {get:(_target,key)=>()=>{calls.push(String(key));throw new Error('read-only materials must not touch downstream');}});
 const service:any=Object.create(FamilyCarService.prototype);Object.assign(service,{repo:repo(0),houseRepo:repo(1),buildingRepo:repo(2),sync:()=>{calls.push('sync');throw new Error('must not sync');},parking:forbidden,operationRepo:forbidden,proofRepo:forbidden,storage:forbidden});
 return {service,calls,file,db};
}

test('资料接口只读且复用detail文件映射，不sync、不查停车任务、不改数据库',async t=>{
 const h=await setup(t);const before=await h.db.query('SELECT * FROM family_cars ORDER BY id');
 assert.equal(typeof h.service.materials,'function','新增纯只读materials方法');
 const result=await h.service.materials(1,{tenantId:1},{scopeAll:false,communityIds:[17]});
 assert.deepEqual(result,{id:1,plate:'SYNTHETIC',files:[{index:0,fileName:h.file.fileName,contentType:h.file.contentType,source:h.file.source,uploadedAt:h.file.uploadedAt,fileUrl:'/api/v1/upload/file?key='+encodeURIComponent(h.file.objectKey)}]});
 assert.deepEqual(h.calls,[]);assert.deepEqual(await h.db.query('SELECT * FROM family_cars ORDER BY id'),before);
});

test('资料接口与detail相同租户及小区load校验，拒绝跨租户/跨小区/空范围',async t=>{
 const h=await setup(t);assert.equal(typeof h.service.materials,'function','新增纯只读materials方法');
 for(const [id,user,access,status] of [[2,{tenantId:1},{scopeAll:false,communityIds:[17]},403],[3,{tenantId:1},{scopeAll:true},404],[1,{tenantId:1},{scopeAll:false,communityIds:[]},403],[1,{}, {scopeAll:true},403]] as any[]){
  await assert.rejects(()=>h.service.materials(id,user,access),(e:any)=>e.getStatus()===status);
 }
 assert.deepEqual(h.calls,[]);
});

test('资料控制器路由及view权限与list/detail完全一致，真实PermissionsGuard拒绝无权者',async()=>{
 const handler=(FamilyCarController.prototype as any).materials;assert.equal(typeof handler,'function','新增materials控制器路由');
 assert.equal(Reflect.getMetadata('path',handler),':id/materials');
 const permission=Reflect.getMetadata(PERMISSION_KEY,handler);assert.deepEqual(permission,Reflect.getMetadata(PERMISSION_KEY,FamilyCarController.prototype.get));assert.deepEqual(permission,Reflect.getMetadata(PERMISSION_KEY,FamilyCarController.prototype.list));
 const accessService:any=Object.create(AccessService.prototype);const guard=new PermissionsGuard(new Reflector(),accessService);
 const context=(access:any)=>({getHandler:()=>handler,getClass:()=>FamilyCarController,switchToHttp:()=>({getRequest:()=>({user:{tenantId:1},access})})}) as any;
 await assert.rejects(()=>guard.canActivate(context({pages:{},scopeAll:true})),(e:any)=>e.getStatus()===403);
 const args:any[]=[];const controller:any=new FamilyCarController({materials:(...a:any[])=>{args.push(...a);return 'ok';}} as any);const user={tenantId:1};const access={scopeAll:true};assert.equal(controller.materials(7,user,access),'ok');assert.deepEqual(args,[7,user,access]);
});
