import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 旧版“作废”使用 deleted_at 隐藏记录；新版以明确的 voided 状态保留、筛选记录。
 * 永久删除是新的管理员动作，不需要新增字段。
 */
export class SplitVoidAndPermanentDelete1788829200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 普通业务角色不再拥有“永久删除”这一动作；系统管理员由身份直通。
    await queryRunner.query(`
      UPDATE role_permissions
         SET can_delete = false
       WHERE page_key = 'work-orders' AND can_delete = true
    `);
    await queryRunner.query(`
      UPDATE role_template_permissions
         SET can_delete = false
       WHERE page_key = 'work-orders' AND can_delete = true
    `);
    await queryRunner.query(`
      UPDATE repair_requests rr
         SET deleted_at = NULL
       WHERE rr.deleted_at IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM work_orders wo
            WHERE wo.request_id = rr.id
              AND wo.tenant_id = rr.tenant_id
              AND wo.deleted_at IS NOT NULL
         )
    `);
    await queryRunner.query(`
      UPDATE work_orders
         SET status = 'voided', deleted_at = NULL
       WHERE deleted_at IS NOT NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 不把已作废记录重新隐藏；回滚代码不应造成业务记录再次消失。
  }
}
