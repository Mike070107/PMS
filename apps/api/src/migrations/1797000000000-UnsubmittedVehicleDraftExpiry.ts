import { MigrationInterface, QueryRunner } from 'typeorm';

export class UnsubmittedVehicleDraftExpiry1797000000000 implements MigrationInterface {
  async up(db: QueryRunner) {
    // Retain the request key after the unsubmitted draft expires, including across client retries.
    await db.query(`CREATE TABLE IF NOT EXISTS expired_vehicle_intake_operations (
      tenant_id int NOT NULL, operation_key varchar(100) NOT NULL, house_id int NOT NULL,
      request_hash varchar(64) NOT NULL, expired_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(tenant_id,operation_key))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_intakes_unsubmitted_created ON vehicle_intakes(created_at)
      WHERE status='waiting' AND submitted_at IS NULL AND transaction_id IS NULL AND family_car_id IS NULL`);
  }
  async down(): Promise<void> { throw new Error('Retain expired request identities on rollback'); }
}
