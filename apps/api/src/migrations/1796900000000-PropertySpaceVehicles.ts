import { MigrationInterface, QueryRunner } from 'typeorm';

export class PropertySpaceVehicles1796900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`ALTER TABLE parking_spaces ADD COLUMN IF NOT EXISTS vehicle_bindings jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query('ALTER TABLE parking_spaces DROP COLUMN vehicle_bindings');
  }
}
