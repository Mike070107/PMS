import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 报修「紧急」标记（2026-08-31）。
 *
 * 业主/员工按住说话时说「这个要急修」，以前这句话只留在描述文本里，
 * 派单的人得逐条读才看得见。现在建单时按同一份口径判定并落库，
 * 工单池 / 在手工单 / 后台列表统一挂红标。
 *
 * 只加列、IF NOT EXISTS —— 开发库 synchronize 已建好时安全跳过。
 * 存量数据不回填：老单的描述里那句「急修」是几天前的诉求，现在再标红
 * 只会把真正新来的急单挤下去。
 */
export class RepairUrgent1788224400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE repair_requests DROP COLUMN IF EXISTS urgent`);
  }
}
