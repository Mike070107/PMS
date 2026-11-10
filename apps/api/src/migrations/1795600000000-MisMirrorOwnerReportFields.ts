import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 旧退款/收费标准报表所需的业主原始字段。说明不等于实时空置/退户状态。
 * 只加可空列，不猜测历史值；由已有管理员手工重灌路径回填，不启动同步。
 */
export class MisMirrorOwnerReportFields1795600000000 implements MigrationInterface {
  name = 'MisMirrorOwnerReportFields1795600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mis_mirror_owner
      ADD COLUMN IF NOT EXISTS owner_note text,
      ADD COLUMN IF NOT EXISTS move_in_date date,
      ADD COLUMN IF NOT EXISTS billing_start_date date`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mis_mirror_owner
      DROP COLUMN IF EXISTS billing_start_date,
      DROP COLUMN IF EXISTS move_in_date,
      DROP COLUMN IF EXISTS owner_note`);
  }
}
