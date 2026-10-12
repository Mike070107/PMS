import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryRunner } from 'typeorm';
import { FeeTemplates1792210000000 } from '../../migrations/1792210000000-FeeTemplates';
import { FeeTemplatesService } from './fee-templates.service';

/** 仅供隔离测试，不能连接生产或替代正式权限认证。 */
export async function fixture() {
  const pg=new PGlite();
  await pg.exec(`CREATE TABLE tenants(id int PRIMARY KEY);INSERT INTO tenants VALUES(1),(2);
    CREATE TABLE communities(id int PRIMARY KEY,tenant_id int,name text,enabled boolean); INSERT INTO communities VALUES(1,1,'公寓甲',true),(2,1,'小区乙',true),(3,2,'他公司',true);
    CREATE TABLE buildings(id int PRIMARY KEY,tenant_id int,community_id int,building_no text,lane text);INSERT INTO buildings VALUES(10,1,1,'A',NULL),(20,1,2,'2',NULL),(30,2,3,'3',NULL);
    CREATE TABLE houses(id int PRIMARY KEY,tenant_id int,building_id int,room_no text,property_type text,area_sqm numeric);INSERT INTO houses VALUES(101,1,10,'101','公寓',80.25),(102,1,10,'102','公寓',NULL),(201,1,20,'101','住宅',50),(301,2,30,'101','公寓',50);
    CREATE TABLE users(id int PRIMARY KEY,tenant_id int,house_id int,name text,role text);INSERT INTO users VALUES(8,1,101,'住户甲','owner');
    CREATE TABLE fee_standards(id serial PRIMARY KEY,tenant_id int,community_id int,house_id int,fee_code text,amount_cents int,standard_cents int,status text,effective_from date,effective_to date);
    CREATE TABLE fee_bills(id serial PRIMARY KEY,house_id int,amount_cents int,snapshot jsonb);`);
  const adapter=(connection:any):any=>({
    query:async(sql:string,params?:any[])=>params?.length || !sql.includes(';')?(await connection.query(sql,params)).rows:(await connection.exec(sql)).at(-1)?.rows??[],
    transaction:async(callback:any)=>pg.transaction(async transaction=>callback(adapter(transaction))),
  });
  const db=adapter(pg) as DataSource;
  await new FeeTemplates1792210000000().up(db as unknown as QueryRunner);
  return {pg,service:new FeeTemplatesService(db),db};
}
