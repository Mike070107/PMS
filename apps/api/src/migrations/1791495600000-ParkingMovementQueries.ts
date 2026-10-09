import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingMovementQueries1791495600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE parking_queries ADD COLUMN IF NOT EXISTS query_kind varchar(20) NOT NULL DEFAULT 'vehicle'");
    await queryRunner.query('ALTER TABLE parking_queries ADD COLUMN IF NOT EXISTS range_start date NULL');
    await queryRunner.query('ALTER TABLE parking_queries ADD COLUMN IF NOT EXISTS range_end date NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE parking_queries DROP COLUMN IF EXISTS range_end');
    await queryRunner.query('ALTER TABLE parking_queries DROP COLUMN IF EXISTS range_start');
    await queryRunner.query('ALTER TABLE parking_queries DROP COLUMN IF EXISTS query_kind');
  }
}
