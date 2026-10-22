import 'reflect-metadata';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {DataSource,QueryResult} from 'typeorm';
import {Broadcaster} from 'typeorm/subscriber/Broadcaster';
import {entities,Community,House} from '../src/entities';
import {MisFeesService} from '../src/modules/fees/mis-fees.service';

/** 隔离PMS元数据，MIS连接仍由真实生产服务实现，只读。 */
export async function misFeesFixture(snapshotPath:string){
 const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8').replace(/^\uFEFF/,''));
 const pg=new PGlite(),ds=new DataSource({type:'postgres',entities,synchronize:false});
 await (ds as any).buildMetadatas();
 ds.createQueryRunner=(()=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:false,data:{},connect:async()=>{},release:async()=>{},query:async(sql:string,params:any[]=[],structured=false)=>{const out=await pg.query(sql,params);if(!structured)return out.rows;const result=new QueryResult();result.records=out.rows;result.raw=out.rows;result.affected=out.affectedRows;return result;}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr;}) as any;
 (ds as any).isInitialized=true;
 await pg.exec(`CREATE TABLE communities(id int PRIMARY KEY,tenant_id int,name text,parent_id int,office_id int,address text,zones jsonb DEFAULT '[]',enabled boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),created_by int,updated_by int);
 CREATE TABLE buildings(id int PRIMARY KEY,tenant_id int,community_id int,lane text,building_no text,road_name text);
 CREATE TABLE houses(id int PRIMARY KEY,tenant_id int,building_id int,room_no text,road_name text,full_address text);
 CREATE TABLE users(id int PRIMARY KEY,tenant_id int,house_id int,name text,phone text,contact_note text,role text,status text);`);
 for(const [table,cols,rows] of [
  ['communities',['id','tenant_id','name','parent_id','office_id','address','enabled'],snapshot.communities],
  ['buildings',['id','tenant_id','community_id','lane','building_no','road_name'],snapshot.buildings],
  ['houses',['id','tenant_id','building_id','room_no','road_name','full_address'],snapshot.houses],
  ['users',['id','tenant_id','house_id','name','phone','contact_note','role','status'],snapshot.users],
 ] as Array<[string,string[],any[]]>){
  for(let start=0;start<rows.length;start+=300){const batch=rows.slice(start,start+300);const params:any[]=[];const values=batch.map(row=>'('+cols.map(col=>{params.push(row[col]??null);return '$'+params.length;}).join(',')+')');await pg.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${values.join(',')}`,params);}
 }
 const service=new MisFeesService(ds.getRepository(Community),ds.getRepository(House));
 return {service,pg,close:async()=>{await service.onModuleDestroy();await pg.close();}};
}
