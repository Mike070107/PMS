import 'reflect-metadata';
import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {DataSource} from 'typeorm';
import * as entities from '../../entities';import {BusinessService} from './business.service';

test('收费落本地车辆表后按车牌仍带回唯一房号，保持租户/小区隔离',async()=>{
 const db=new PGlite();const ds=new DataSource({type:'postgres',entities:Object.values(entities).filter(v=>typeof v==='function') as any});
 await (ds as any).buildMetadatas();
 (ds as any).query=async(sql:string,params:any[]) => (await db.query(sql,params)).rows;
 const createTable=async(entity:any)=>{const meta=ds.getMetadata(entity);await db.exec(`CREATE TABLE ${meta.tableName} (${meta.columns.map(c=>{
  const t=c.type;const sql=t===Number||t==='int'||t==='integer'?'integer':t===Boolean||t==='boolean'?'boolean':t==='jsonb'||t==='json'?'jsonb':t===Date||String(t).includes('timestamp')?'timestamptz':t==='date'?'date':'text';return '"'+c.databaseName+'" '+sql;
 }).join(',')})`);};
 try{
  await db.exec(`CREATE TABLE communities(id int,tenant_id int,name text);
CREATE TABLE buildings(id int,tenant_id int,community_id int,lane text,building_no text,road_name text);
CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,area_sqm numeric,shop_name text,unit_id int);
CREATE TABLE units(id int,tenant_id int,building_id int,unit_no text);
CREATE TABLE users(id int,tenant_id int,house_id int,role text,name text,phone text);
INSERT INTO communities VALUES(1,991,'隔离测试一期'),(2,991,'隔离测试二期'),(3,992,'其他租户');
INSERT INTO buildings VALUES(1,991,1,'198','37','测试路'),(2,991,2,'228','11','测试路'),(3,992,3,'198','37','测试路');
INSERT INTO houses VALUES(749,991,1,'401',80,null),(750,991,2,'1102',90,null),(850,992,3,'401',80,null);`);
  await createTable(entities.ParkingVehicle);await createTable(entities.AccessCard);
  const repo=(entity:any,alias:string,raw=false)=>({manager:{connection:ds},createQueryBuilder:()=>{
   const real=ds.getRepository(entity),qb=real.createQueryBuilder(alias);const execute=async()=>{const [sql,args]=qb.getQueryAndParameters();const rows=(await db.query(sql,args)).rows;
    return raw?rows:rows.map((row:any)=>Object.fromEntries(real.metadata.columns.map(col=>[col.propertyName,row[alias+'_'+col.databaseName]])));};
   if(raw)qb.getRawMany=execute as any;else qb.getMany=execute as any;return qb;
  }});
  const svc:any=Object.create(BusinessService.prototype);svc.houseRepo=repo(entities.House,'h',true);svc.vehicleRepo=repo(entities.ParkingVehicle,'v');svc.cardRepo=repo(entities.AccessCard,'ac');
  const user={id:8,tenantId:991},scope={scopeAll:false,communityIds:[1]};
  await db.exec(`INSERT INTO buildings VALUES(4,991,1,null,'729','测试路'),(5,991,2,null,'729','测试路'),(6,991,1,null,'B座','公寓路');
    INSERT INTO units VALUES(61,991,6,'2');
    INSERT INTO houses VALUES(901,991,4,'商铺',0,null,null),(902,991,5,'商铺',0,null,null),(903,991,6,'A-009',0,null,61);`);
  for(const [term,id] of [['729商铺',901],['729/商铺',901],['B座/2/A-009',903]] as const){
    const result=await svc.search({q:term},user,scope);assert.deepEqual(result.houses.map((h:any)=>h.id),[id],term);
  }
  assert.equal((await svc.search({q:'沪TEST01'},user,scope)).vehicles.length,0);
  await db.query('INSERT INTO parking_vehicles(id,tenant_id,plate_no,house_id,status) VALUES($1,$2,$3,$4,$5)',[8,991,'沪TEST01',749,'active']);
  await db.query('INSERT INTO parking_vehicles(id,tenant_id,plate_no,house_id,status) VALUES($1,$2,$3,$4,$5)',[9,992,'沪TEST01',850,'active']);
  const got=await svc.search({q:'沪TEST01'},user,scope);assert.deepEqual(got.houses.map((h:any)=>h.id),[749]);assert.deepEqual(got.vehicles.map((v:any)=>v.id),[8]);
  assert.equal(got.vehicles[0].houseId,got.houses[0].id);
  for(const access of [{scopeAll:false,communityIds:[2]},{scopeAll:false,communityIds:[]}]){const hidden=await svc.search({q:'沪TEST01'},user,access);assert.deepEqual(hidden.houses,[]);assert.deepEqual(hidden.vehicles,[]);}
 }finally{await db.close();}
});
