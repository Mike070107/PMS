import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 独立保存具体位置；历史完整地址不猜测、不回填。 */
export class RepairLocationText1793900000000 implements MigrationInterface {
  name = 'RepairLocationText1793900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS location_text varchar(60)`);
  }

  async down(): Promise<void> {
    throw new Error('具体位置包含报修记录，回退应用时保留新增列，禁止自动删除。');
  }
}
