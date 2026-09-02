import { MigrationInterface, QueryRunner } from 'typeorm';

/** 可审计作废工单：默认业务查询排除，原值仍可追溯。 */
export class WorkOrderVoid1788573600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL`);
    await queryRunner.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS voided_by int NULL`);
    await queryRunner.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS void_reason varchar(500) NULL`);
    await queryRunner.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS void_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_deleted ON work_orders (tenant_id, deleted_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_repair_requests_tenant_deleted ON repair_requests (tenant_id, deleted_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_work_orders_tenant_deleted`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_repair_requests_tenant_deleted`);
    await queryRunner.query(`ALTER TABLE repair_requests DROP COLUMN IF EXISTS deleted_at`);
    await queryRunner.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS void_snapshot`);
    await queryRunner.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS void_reason`);
    await queryRunner.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS voided_by`);
    await queryRunner.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS deleted_at`);
  }
}
