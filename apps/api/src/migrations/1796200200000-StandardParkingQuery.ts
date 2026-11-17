import { MigrationInterface, QueryRunner } from 'typeorm';
/** Server-only link to the original parking query; no business rows are updated. */
export class StandardParkingQuery1796200200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE local_integration_tasks ADD COLUMN IF NOT EXISTS parking_query_id integer NULL');
    await q.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_local_integration_parking_query ON local_integration_tasks (tenant_id, parking_query_id) WHERE parking_query_id IS NOT NULL');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS uq_local_integration_parking_query');
    await q.query('ALTER TABLE local_integration_tasks DROP COLUMN IF EXISTS parking_query_id');
  }
}
