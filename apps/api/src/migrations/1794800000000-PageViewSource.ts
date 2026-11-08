import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 页面访问来源：page_views 增加 source（web / miniapp-staff / miniapp-owner）。
 *
 * 生产 DB_SYNCHRONIZE=true 时由实体同步建列；本迁移供标准部署/测试库使用，全部 IF NOT EXISTS。
 * 旧数据（含加列前的记录）默认 web：**2026-11-08 之前的历史访问都记 web，不代表全部来自网页**。
 * 小程序上报需要客户端带 source 才会区分 miniapp-staff（员工端）/ miniapp-owner（业主端）。
 */
export class PageViewSource1794800000000 implements MigrationInterface {
  name = 'PageViewSource1794800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'web'`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_page_views_tenant_source_created ON page_views(tenant_id, source, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS idx_page_views_tenant_source_created');
    await q.query('ALTER TABLE page_views DROP COLUMN IF EXISTS source');
  }
}
