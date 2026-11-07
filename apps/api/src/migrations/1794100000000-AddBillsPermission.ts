import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 「账单与待缴」独立成可授权页面（bills）。
 *
 * 生产仍由 AccessService.onModuleInit 兼容 DB_SYNCHRONIZE=true 的存量库；
 * 本迁移供 DB_SYNCHRONIZE=false 的标准部署使用。只加行、幂等：
 * - role_permissions / role_template_permissions：有 fees 的角色 / 模板补 bills，
 *   can_view / can_edit 跟随 fees，can_delete=false（页面本身没有删除动作）；
 * - tenants.enabled_pages：只勾了 fees 的公司追加 bills，否则新页面会被可用页面裁剪掉。
 *
 * 回滚：删除 bills 权限行并从 enabled_pages 去掉 bills；fees 与人工配置不受影响。
 * 注意回滚会一并删除迁移后管理员手动勾选的 bills 行，执行前先备份这两张表。
 */
export class AddBillsPermission1794100000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const [table, owner] of [
      ['role_permissions', 'role_id'],
      ['role_template_permissions', 'template_id'],
    ] as const) {
      await q.query(`
        INSERT INTO ${table}
          (tenant_id, ${owner}, page_key, can_view, can_edit, can_delete, created_at, updated_at)
        SELECT src.tenant_id, src.${owner}, 'bills', src.can_view, src.can_edit, false, now(), now()
          FROM ${table} src
         WHERE src.page_key = 'fees'
           AND NOT EXISTS (
             SELECT 1 FROM ${table} dst
              WHERE dst.${owner} = src.${owner}
                AND dst.page_key = 'bills'
           )
      `);
    }
    await q.query(`
      UPDATE tenants
         SET enabled_pages = enabled_pages || '["bills"]'::jsonb,
             updated_at = now()
       WHERE enabled_pages IS NOT NULL
         AND enabled_pages ? 'fees'
         AND NOT enabled_pages ? 'bills'
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE tenants
         SET enabled_pages = enabled_pages - 'bills',
             updated_at = now()
       WHERE enabled_pages IS NOT NULL
         AND enabled_pages ? 'bills'
    `);
    await q.query(`DELETE FROM role_template_permissions WHERE page_key = 'bills'`);
    await q.query(`DELETE FROM role_permissions WHERE page_key = 'bills'`);
  }
}
