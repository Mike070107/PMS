import { MigrationInterface, QueryRunner } from 'typeorm';
export class SelfProfilePhoneVerification1791765000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_reverification_required boolean NOT NULL DEFAULT false');
    await queryRunner.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 0');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE users DROP COLUMN IF EXISTS phone_reverification_required');
    await queryRunner.query('ALTER TABLE users DROP COLUMN IF EXISTS credential_version');
  }
}
