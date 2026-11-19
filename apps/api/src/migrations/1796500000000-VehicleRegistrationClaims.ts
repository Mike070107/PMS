import { MigrationInterface, QueryRunner } from 'typeorm';

/** Empty registry on purpose: historical conflicts require a read-only report, never an automatic winner. */
export class VehicleRegistrationClaims1796500000000 implements MigrationInterface {
  name = 'VehicleRegistrationClaims1796500000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS vehicle_registration_claims (
      tenant_id integer NOT NULL,
      plate varchar(16) NOT NULL,
      intake_id integer REFERENCES vehicle_intakes(id),
      family_car_id integer REFERENCES family_cars(id),
      claimed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, plate),
      CHECK (intake_id IS NOT NULL OR family_car_id IS NOT NULL)
    )`);
  }
  async down(): Promise<void> { throw new Error('Vehicle registration claims are retained; do not roll back business ownership'); }
}
