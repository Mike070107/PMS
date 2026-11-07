import { MigrationInterface, QueryRunner } from 'typeorm';

/** 登录尝试（成功+失败）。失败记录的账号已脱敏，写入是旁路 fire-and-forget。 */
export class LoginAttempts1794200000001 implements MigrationInterface {
  name = 'LoginAttempts1794200000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS login_attempts (
      id serial PRIMARY KEY,
      tenant_id int,
      user_id int,
      user_name varchar(60),
      account_masked varchar(80),
      ip varchar(64),
      user_agent varchar(200),
      method varchar(10) NOT NULL,
      status varchar(10) NOT NULL,
      reason varchar(40),
      message varchar(200),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_tenant_created ON login_attempts(tenant_id, created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_tenant_status_created ON login_attempts(tenant_id, status, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS login_attempts');
  }
}
