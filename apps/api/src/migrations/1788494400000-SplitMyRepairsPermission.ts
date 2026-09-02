import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 将原来的「在手工单 / 我的报修」拆成两格。
 *
 * 生产目前仍由 AccessService.onModuleInit 兼容 DB_SYNCHRONIZE=true 的存量库；
 * 这条迁移供 DB_SYNCHRONIZE=false 的标准部署使用。两边均为幂等插入，已有人工配置不覆盖。
 */
export class SplitMyRepairsPermission1788494400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.copyPermission(queryRunner, 'role_permissions', 'role_id');
    await this.copyPermission(queryRunner, 'role_template_permissions', 'template_id');
  }

  private async copyPermission(
    queryRunner: QueryRunner,
    table: string,
    ownerColumn: string,
  ): Promise<void> {
    await queryRunner.query(`
      INSERT INTO ${table}
        (tenant_id, ${ownerColumn}, page_key, can_view, can_edit, can_delete, created_at, updated_at)
      SELECT src.tenant_id, src.${ownerColumn}, 'app:my-repairs', src.can_view, false, false, now(), now()
        FROM ${table} src
       WHERE src.page_key = 'app:my-orders'
         AND NOT EXISTS (
           SELECT 1
             FROM ${table} dst
            WHERE dst.${ownerColumn} = src.${ownerColumn}
              AND dst.page_key = 'app:my-repairs'
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM role_template_permissions WHERE page_key = 'app:my-repairs'`);
    await queryRunner.query(`DELETE FROM role_permissions WHERE page_key = 'app:my-repairs'`);
  }
}
