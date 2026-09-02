import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 盘点单（2026-09-01）。
 *
 * 只新增一张表、全部 IF NOT EXISTS —— 开发库 synchronize 已建好时安全跳过。
 * 不动 tenants.enabled_pages：盘点挂在已有的「库存与采购」（inventory）页面权限下，
 * 员工端入口挂 app:inventory，没有新的页面 key。
 */
export class StocktakeOrders1788483600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stocktake_orders (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        stocktake_no varchar(40) NOT NULL,
        warehouse_id int NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'counting',
        items jsonb NOT NULL DEFAULT '[]',
        note varchar(255),
        reject_reason varchar(255),
        applicant_id int,
        submitted_at timestamptz,
        approver_id int,
        approved_at timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_stocktake_orders_tenant ON stocktake_orders (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_stocktake_orders_tenant_status ON stocktake_orders (tenant_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_stocktake_orders_tenant_warehouse ON stocktake_orders (tenant_id, warehouse_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS stocktake_orders`);
  }
}
