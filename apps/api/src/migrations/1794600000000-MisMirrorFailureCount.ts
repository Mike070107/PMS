import { MigrationInterface, QueryRunner } from 'typeorm';

/** MIS 镜像同步连续失败计数：连续 3 次（约 15 分钟）才升级微信告警。 */
export class MisMirrorFailureCount1794600000000 implements MigrationInterface {
  name = 'MisMirrorFailureCount1794600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0');
    await q.query('ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS last_failure_at timestamptz');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_sync_state DROP COLUMN IF EXISTS last_failure_at');
    await q.query('ALTER TABLE mis_sync_state DROP COLUMN IF EXISTS consecutive_failures');
  }
}
