import { MigrationInterface, QueryRunner } from 'typeorm';

/** 一次性继承原来的收费台访问权；之后两个菜单的授权可独立修改。 */
export class ApartmentCashierPermission1792100400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE tenants SET enabled_pages = enabled_pages || '["apartment-cashier"]'::jsonb
      WHERE enabled_pages ? 'fees' AND NOT enabled_pages ? 'apartment-cashier'`);
    for (const [table, owner] of [['role_permissions', 'role_id'], ['role_template_permissions', 'template_id']]) {
      await q.query(`INSERT INTO ${table} (tenant_id, ${owner}, page_key, can_view, can_edit, can_delete)
        SELECT tenant_id, ${owner}, 'apartment-cashier', can_view, can_edit, false
        FROM ${table} WHERE page_key = 'fees'
        ON CONFLICT (${owner}, page_key) DO NOTHING`);
    }
  }

  async down(): Promise<void> {
    // 授权可能已由管理员独立调整，回滚代码时保留权限记录，避免删除管理员配置。
  }
}
