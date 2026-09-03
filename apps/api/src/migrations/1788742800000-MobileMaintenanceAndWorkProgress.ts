import { MigrationInterface, QueryRunner } from 'typeorm';

/** 一次性养护签名会话，以及工单进度节点的现场图片。 */
export class MobileMaintenanceAndWorkProgress1788742800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS maintenance_sign_sessions (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        maintenance_order_id int NOT NULL,
        slot varchar(20) NOT NULL,
        requested_by int NOT NULL,
        signer_name varchar(60) NULL,
        expires_at timestamptz NOT NULL,
        opened_at timestamptz NULL,
        submitted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_sign_order ON maintenance_sign_sessions (tenant_id, maintenance_order_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_sign_expiry ON maintenance_sign_sessions (expires_at)`);
    await queryRunner.query(`ALTER TABLE work_order_logs ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE work_order_logs DROP COLUMN IF EXISTS attachments`);
    await queryRunner.query(`DROP TABLE IF EXISTS maintenance_sign_sessions`);
  }
}
