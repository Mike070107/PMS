import { MigrationInterface, QueryRunner } from 'typeorm';

/** 保留一句话/语音报修在拆字段前的原文，供工单详情追溯。 */
export class RepairOriginalContent1789174800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE repair_requests
        ADD COLUMN IF NOT EXISTS original_content text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE repair_requests
        DROP COLUMN IF EXISTS original_content
    `);
  }
}
