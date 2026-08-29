import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 角色额外可见的仓库（2026-08-30）。
 *
 * 起因：「枫桦景苑办公室」数据范围是枫桦景苑管理处，要让它用总公司那个总仓。
 * 总仓 office_id 为空，受限角色的可见仓又是按 office_id 匹配的 —— 数据范围
 * 表达不了「除了本管理处，再加这一个仓」。
 */
export class RoleExtraWarehouses1788051600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS role_warehouses (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        role_id int NOT NULL,
        warehouse_id int NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_role_warehouses_tenant ON role_warehouses (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_role_warehouses_role ON role_warehouses (role_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_role_warehouses ON role_warehouses (role_id, warehouse_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS role_warehouses`);
  }
}
