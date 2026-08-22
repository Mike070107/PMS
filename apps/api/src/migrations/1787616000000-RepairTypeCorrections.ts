import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 报修类型纠错记录表（2026-08-21，随「随手拍地址识别 + 类型纠错自学习」上线）。
 * 只新增对象、全部 IF NOT EXISTS —— 开发库 synchronize 已建好时安全跳过。
 * 地址识别本身不需要任何新表：撞的是既有的 communities/buildings/houses。
 */
export class RepairTypeCorrections1787616000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS repair_type_corrections (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        work_order_id int NOT NULL,
        request_id int NOT NULL,
        from_type varchar(60),
        to_type varchar(60) NOT NULL,
        content text NOT NULL,
        learned_keywords jsonb NOT NULL DEFAULT '[]'
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_repair_type_corrections_tenant_wo ON repair_type_corrections (tenant_id, work_order_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_repair_type_corrections_tenant_wo`);
    await queryRunner.query(`DROP TABLE IF EXISTS repair_type_corrections`);
  }
}
