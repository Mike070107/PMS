import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 密码登录防爆破：login_attempts 增加归一化账号 account_key。
 *
 * 不新建表；仍复用 login_attempts 的 failed/reason/created_at 做 15 分钟窗口计数。
 * account_masked 继续用于页面展示，account_key 存归一化账号的 SHA-256（不落明文账号）。
 */
export class AddLoginAttemptAccountKey1794400000000 implements MigrationInterface {
  name = 'AddLoginAttemptAccountKey1794400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS account_key varchar(120)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_login_attempts_lockout ON login_attempts(tenant_id, account_key, method, created_at)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS idx_login_attempts_lockout');
    await q.query('ALTER TABLE login_attempts DROP COLUMN IF EXISTS account_key');
  }
}
