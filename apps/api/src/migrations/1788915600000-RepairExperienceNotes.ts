import { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairExperienceNotes1788915600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS repair_experience_notes (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        office_id integer NOT NULL,
        repair_type varchar(60) NOT NULL,
        title varchar(160) NOT NULL,
        blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer,
        updated_by integer
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_repair_experience_notebook ON repair_experience_notes (tenant_id, office_id, repair_type)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_repair_experience_updated ON repair_experience_notes (tenant_id, updated_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS repair_experience_notes');
  }
}
