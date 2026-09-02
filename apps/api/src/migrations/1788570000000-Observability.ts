import { MigrationInterface, QueryRunner } from 'typeorm';

/** 企业级登录/操作/异常日志与 30 天请求指标。 */
export class Observability1788570000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        tenant_id int NULL,
        category varchar(20) NOT NULL,
        level varchar(12) NOT NULL DEFAULT 'info',
        source varchar(30) NOT NULL,
        action varchar(100) NOT NULL,
        success boolean NOT NULL DEFAULT true,
        actor_user_id int NULL,
        ip_address varchar(64) NULL,
        user_agent varchar(500) NULL,
        request_method varchar(10) NULL,
        request_path varchar(300) NULL,
        status_code int NULL,
        duration_ms int NULL,
        message varchar(500) NOT NULL,
        detail jsonb NULL,
        fingerprint varchar(120) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_tenant_created ON system_logs (tenant_id, created_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_tenant_category_created ON system_logs (tenant_id, category, created_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_system_logs_fingerprint_created ON system_logs (fingerprint, created_at)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS request_metrics (
        id SERIAL PRIMARY KEY,
        tenant_id int NULL,
        source varchar(30) NOT NULL,
        method varchar(10) NOT NULL,
        path varchar(240) NOT NULL,
        status_code int NOT NULL,
        duration_ms int NOT NULL,
        actor_user_id int NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_request_metrics_tenant_created ON request_metrics (tenant_id, created_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_request_metrics_tenant_source_created ON request_metrics (tenant_id, source, created_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS request_metrics`);
    await queryRunner.query(`DROP TABLE IF EXISTS system_logs`);
  }
}
