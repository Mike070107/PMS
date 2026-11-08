import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { ScreenSettingsService } from '../src/modules/fees/screen-settings.service';
import { CollectionTargetsService } from '../src/modules/fees/collection-targets.service';
export async function screenFixture(){
  const pg=new PGlite();
  await pg.exec(`CREATE TABLE communities(id int PRIMARY KEY,tenant_id int,name text,enabled boolean);
    INSERT INTO communities VALUES(1,1,'枫桦景苑一期',true),(2,1,'上海新家',true),(3,2,'其他公司',true);
    CREATE TABLE tenant_configs(id serial PRIMARY KEY,tenant_id int NOT NULL,key varchar(60) NOT NULL,value jsonb NOT NULL,
    created_by int,updated_by int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(tenant_id,key));
    CREATE TABLE collection_targets(id serial PRIMARY KEY,tenant_id int,community_id int,community_ids int[],fee_code text,year int,
    annual_cents bigint,month_cents jsonb,created_by int,updated_by int,updated_at timestamptz DEFAULT now());`);
  const db:any={query:async(sql:string,params:any[]=[])=>{const out=await pg.query(sql,params);return out.rows;}};
  return {pg,db,settings:new ScreenSettingsService(db),targets:new CollectionTargetsService(db)};
}
export const manualFixture={sample:true,asOf:'2026-11-08',note:'隔离测试人工台账',overdueHouses:12,overdueCents:18600000,
  untouchedHouses:8,untouchedCents:26400000,disputeCount:6,disputeCents:9200000,recoveredCents:38600000,duePromises:25,keptPromises:18,pendingHouses:28};
