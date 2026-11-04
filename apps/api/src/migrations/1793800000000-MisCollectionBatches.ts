import { MigrationInterface, QueryRunner } from 'typeorm';
/** Additive PMS-only storage. Never writes to the MIS source. */
export class MisCollectionBatches1793800000000 implements MigrationInterface {
 async up(runner:QueryRunner):Promise<void>{
  await runner.query(`CREATE TABLE IF NOT EXISTS mis_collection_batches (
   id SERIAL PRIMARY KEY, tenant_id integer NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
   created_by integer, updated_by integer,idempotency_key varchar(64) NOT NULL,
   community_ids integer[] NOT NULL,purpose varchar(10) NOT NULL,status varchar(30) NOT NULL,
   fingerprint varchar(64) NOT NULL,house_count integer NOT NULL,amount_cents bigint NOT NULL,snapshot jsonb NOT NULL
  )`);
  await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS mis_collection_batches_tenant_key ON mis_collection_batches(tenant_id,idempotency_key)`);
  await runner.query(`CREATE INDEX IF NOT EXISTS mis_collection_batches_tenant_recent ON mis_collection_batches(tenant_id,id DESC)`);
 }
 async down():Promise<void>{throw new Error('催缴快照为审计记录，不自动删除；请先备份并人工核实回退方案');}
}
