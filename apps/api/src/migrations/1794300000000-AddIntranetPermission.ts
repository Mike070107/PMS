import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 「内网应用」独立成可授权页面（intranet）。
 *
 * 生产仍由 AccessService.onModuleInit 兼容 DB_SYNCHRONIZE=true 的存量库；
 * 本迁移供 DB_SYNCHRONIZE=false 的标准部署使用，双轨幂等：
 * - role_permissions / role_template_permissions：有 settings 的角色/模板补 intranet，
 *   can_view 跟随 settings.can_view，can_edit=false，can_delete=false。
 * - tenants.enabled_pages：只给已启用 settings 的公司追加 intranet，避免新页面被可用页面裁掉。
 *
 * 回滚：删除 intranet 权限行并从 enabled_pages 移除 intranet；
 * 注意回滚会一并删掉迁移后管理员手动勾选的 intranet 行，执行前先备份这两张权限表。
 */
export class AddIntranetPermission1794300000000 implements MigrationInterface {
  name = 'AddIntranetPermission1794300000000';

  async up(q: QueryRunner): Promise<void> {
    for (const [table, owner] of [
      ['role_permissions', 'role_id'],
      ['role_template_permissions', 'template_id'],
    ] as const) {
      await q.query(`
        INSERT INTO ${table}
          (tenant_id, ${owner}, page_key, can_view, can_edit, can_delete, created_at, updated_at)
        SELECT src.tenant_id, src.${owner}, 'intranet', src.can_view, false, false, now(), now()
          FROM ${table} src
         WHERE src.page_key = 'settings'
           AND NOT EXISTS (
             SELECT 1 FROM ${table} dst
              WHERE dst.${owner} = src.${owner}
                AND dst.page_key = 'intranet'
           )
      `);
    }
    await q.query(`
      UPDATE tenants
         SET enabled_pages = enabled_pages || '["intranet"]'::jsonb,
             updated_at = now()
       WHERE enabled_pages IS NOT NULL
         AND enabled_pages ? 'settings'
         AND NOT enabled_pages ? 'intranet'
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE tenants
         SET enabled_pages = enabled_pages - 'intranet',
             updated_at = now()
       WHERE enabled_pages IS NOT NULL
         AND enabled_pages ? 'intranet'
    `);
    await q.query("DELETE FROM role_template_permissions WHERE page_key = 'intranet'");
    await q.query("DELETE FROM role_permissions WHERE page_key = 'intranet'");
  }
}
