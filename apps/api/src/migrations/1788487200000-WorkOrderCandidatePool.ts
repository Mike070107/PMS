import { MigrationInterface, QueryRunner } from 'typeorm';

/** 记录新工单进入工单池时实际通知的维修工，避免按类型跨管理处串单。 */
export class WorkOrderCandidatePool1788487200000 implements MigrationInterface {
  name = 'WorkOrderCandidatePool1788487200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "candidate_ids" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_work_orders_candidate_ids" ON "work_orders" USING GIN ("candidate_ids")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_work_orders_candidate_ids"`);
    await queryRunner.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "candidate_ids"`);
  }
}
