import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingHistoryOperationTime1789531200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE parking_history ADD COLUMN IF NOT EXISTS time_basis varchar(20) NOT NULL DEFAULT 'detected'");
    await queryRunner.query("UPDATE parking_history SET time_basis = 'operation' WHERE source = 'pms'");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE parking_history DROP COLUMN IF EXISTS time_basis');
  }
}
