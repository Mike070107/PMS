import { MigrationInterface, QueryRunner } from 'typeorm';

export class AiAssistLearning1788400800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai_assist_feedback (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        kind varchar(20) NOT NULL,
        work_order_id int NULL,
        source_text text NOT NULL,
        draft jsonb NOT NULL DEFAULT '{}'::jsonb,
        final_value jsonb NOT NULL DEFAULT '{}'::jsonb,
        field_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
        status varchar(20) NOT NULL DEFAULT 'confirmed',
        model varchar(80) NULL,
        prompt_version varchar(30) NOT NULL DEFAULT '2026-09-02',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_ai_feedback_kind_status ON ai_assist_feedback (tenant_id, kind, status)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_ai_feedback_work_order ON ai_assist_feedback (tenant_id, work_order_id)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS repair_fee_rules (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        code varchar(60) NOT NULL,
        name varchar(120) NOT NULL,
        repair_type varchar(60) NULL,
        office_id int NULL,
        keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
        fee_cents int NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL,
        CONSTRAINT uq_repair_fee_rules_tenant_code UNIQUE (tenant_id, code)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_repair_fee_rules_enabled ON repair_fee_rules (tenant_id, enabled)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS repair_fee_rules`);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_assist_feedback`);
  }
}
