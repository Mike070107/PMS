import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccessCardIcNoReservation1792018800000 implements MigrationInterface {
  name = 'AccessCardIcNoReservation1792018800000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE access_card_legacy_card_checks ADD COLUMN IF NOT EXISTS allocated_ic_no integer NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_access_card_allocated_ic_no ON access_card_legacy_card_checks (tenant_id, allocated_ic_no) WHERE allocated_ic_no IS NOT NULL`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_access_card_allocated_ic_no`);
    await queryRunner.query(`ALTER TABLE access_card_legacy_card_checks DROP COLUMN IF EXISTS allocated_ic_no`);
  }
}
