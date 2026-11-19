import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: no historic drafts are deleted, merged, cancelled or replayed. */
export class VehicleIntakeOperations1796300000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS vehicle_intake_operations (
      tenant_id integer NOT NULL,
      operation_key varchar(100) NOT NULL,
      house_id integer NOT NULL REFERENCES houses(id),
      request_hash varchar(64) NOT NULL,
      intake_id integer NOT NULL REFERENCES vehicle_intakes(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, operation_key)
    )`);
  }

  async down(): Promise<void> {
    // Intentionally retain request identity on application rollback. Dropping this table
    // could turn an ambiguous, previously committed operation into a second registration.
    throw new Error('Retain vehicle_intake_operations on rollback; use a reviewed forward migration');
  }
}
