import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: no historical approvals, payments or business rows are rewritten. */
export class VehicleMaterialVersions1796600000000 implements MigrationInterface {
  name = 'VehicleMaterialVersions1796600000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE vehicle_intakes
      ADD COLUMN IF NOT EXISTS input_source varchar(10) NOT NULL DEFAULT 'owner',
      ADD COLUMN IF NOT EXISTS data_version integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS office_confirmed_version integer,
      ADD COLUMN IF NOT EXISTS registration_term jsonb,
      ADD COLUMN IF NOT EXISTS material_history jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await runner.query(`ALTER TABLE family_cars
      ADD COLUMN IF NOT EXISTS data_version integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS office_confirmed_version integer,
      ADD COLUMN IF NOT EXISTS manager_approved_version integer,
      ADD COLUMN IF NOT EXISTS material_history jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }
  async down(): Promise<void> {
    throw new Error('Retain vehicle material versions and audit history; roll back application only');
  }
}
