import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only. Historical records are deliberately not replayed or backfilled. */
export class FamilyCarExecutionCheck1796400000000 implements MigrationInterface {
  name = 'FamilyCarExecutionCheck1796400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE family_cars ADD COLUMN IF NOT EXISTS duplicate_check_query_id integer');
    await queryRunner.query('ALTER TABLE family_cars ADD COLUMN IF NOT EXISTS registration_term jsonb');
  }

  async down(): Promise<void> {
    throw new Error('Retain family_cars execution columns on rollback; use a reviewed forward migration');
  }
}
