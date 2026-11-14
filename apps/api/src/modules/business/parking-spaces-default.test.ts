import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { PGlite } from '@electric-sql/pglite';
import { ParkingSpace } from '../../entities/parking-space.entity';

test('新增车位默认产权，显式租赁仍保持原类别', async () => {
 const source=new DataSource({type:'postgres',entities:[ParkingSpace]});
 await (source as any).buildMetadatas();
 assert.equal(source.getMetadata(ParkingSpace).findColumnWithPropertyName('category')?.default,'property');
});
test('补齐两库未设置类别，保留租赁/空置/其他库与全部原资料，幂等', async () => {
 let Migration:any;try{Migration=require('../../migrations/1796100000001-ParkingSpaceDefaultProperty').ParkingSpaceDefaultProperty1796100000001;}catch(e:any){if(e.code!=='MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof Migration,'function','补齐默认产权的正式迁移必须存在');
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE parking_spaces(id serial primary key,garage text,category varchar(20),note text,plate text,owner_tel text);
   INSERT INTO parking_spaces(garage,category,note,plate,owner_tel) VALUES
    ('main',NULL,'公司备注','沪A12345','021-12345678'),('civil',NULL,'租赁车位',NULL,NULL),
    ('civil','rental','原有租赁',NULL,NULL),('main','vacant','保留已设置',NULL,NULL),
    ('other',NULL,'不属于两库',NULL,NULL),('main','   ','空白类别',NULL,NULL);`);
  const before=(await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows;
  const migration=new Migration();const runner:any={query:(sql:string)=>db.query(sql)};
  await migration.up(runner);const after:any[]=(await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows;
  assert.deepEqual(after.map(r=>r.category),['property','rental','rental','vacant',null,'property']);
  assert.deepEqual(after.map(({category,...r})=>r),before.map(({category,...r})=>r),'不改备注/车牌/电话等原资料');
  await migration.up(runner);assert.deepEqual((await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows,after);
  const created:any=await db.query("INSERT INTO parking_spaces(garage) VALUES('main') RETURNING category");assert.equal(created.rows[0].category,'property');
 }finally{await db.close();}
});
