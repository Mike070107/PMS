import { MigrationInterface, QueryRunner } from 'typeorm';
/** Additive, idempotent PMS-local records only. No MIS schema or historical financial data is changed. */
export class MisCollectionFollowups1794000000000 implements MigrationInterface {
 async up(q:QueryRunner):Promise<void>{
  const base='id SERIAL PRIMARY KEY,tenant_id integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by integer,updated_by integer';
  await q.query(`CREATE TABLE IF NOT EXISTS mis_collection_promises(${base},house_key varchar(70) NOT NULL,community_id integer NOT NULL,promised_date date NOT NULL,promised_cents bigint NOT NULL,status varchar(16) NOT NULL DEFAULT 'active',request_key varchar(36) NOT NULL,snapshot jsonb NOT NULL)`);
  await q.query(`CREATE TABLE IF NOT EXISTS mis_collection_holds(${base},house_key varchar(70) NOT NULL,community_id integer NOT NULL,reason varchar(12) NOT NULL,until_date date NOT NULL,status varchar(16) NOT NULL DEFAULT 'active',request_key varchar(36) NOT NULL)`);
  await q.query(`CREATE TABLE IF NOT EXISTS mis_collection_events(${base},house_key varchar(70) NOT NULL,community_id integer NOT NULL,action varchar(20) NOT NULL,note varchar(500) NOT NULL DEFAULT '',fingerprint varchar(64) NOT NULL,record_id integer,request_key varchar(36) NOT NULL)`);
  await q.query(`CREATE TABLE IF NOT EXISTS mis_collection_prints(${base},batch_id integer NOT NULL,operator_id integer NOT NULL,page_count integer NOT NULL,notice_page_count integer NOT NULL,paper varchar(2) NOT NULL,printed_at timestamptz NOT NULL,request_key varchar(36) NOT NULL)`);
  for(const table of ['promises','holds','events','prints'])await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS mis_collection_${table}_request ON mis_collection_${table}(tenant_id,request_key)`);
  await q.query('CREATE INDEX IF NOT EXISTS mis_collection_promises_scope ON mis_collection_promises(tenant_id,community_id,status)');
  await q.query('CREATE INDEX IF NOT EXISTS mis_collection_holds_scope ON mis_collection_holds(tenant_id,community_id,status)');
  await q.query('CREATE INDEX IF NOT EXISTS mis_collection_events_house ON mis_collection_events(tenant_id,house_key,created_at)');
  await q.query('CREATE INDEX IF NOT EXISTS mis_collection_prints_batch ON mis_collection_prints(tenant_id,batch_id)');
 }
 async down():Promise<void>{throw new Error('催缴跟进和打印审计不可自动删除，请备份后人工处理回退');}
}
