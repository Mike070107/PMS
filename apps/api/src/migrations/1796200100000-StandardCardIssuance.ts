import { MigrationInterface, QueryRunner } from 'typeorm';
/** Nullable, server-only issuance bindings preserve existing generic integration tasks. */
export class StandardCardIssuance1796200100000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE local_integration_tasks ADD COLUMN IF NOT EXISTS issuance_item_id integer NULL');
    await q.query('ALTER TABLE local_integration_tasks ADD COLUMN IF NOT EXISTS allocation_id integer NULL');
    await q.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_local_integration_issuance_operation ON local_integration_tasks (tenant_id, issuance_item_id, operation) WHERE issuance_item_id IS NOT NULL');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS uq_local_integration_issuance_operation');
    await q.query('ALTER TABLE local_integration_tasks DROP COLUMN IF EXISTS allocation_id, DROP COLUMN IF EXISTS issuance_item_id');
  }
}
