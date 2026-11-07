import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 页面访问埋点。生产 DB_SYNCHRONIZE=true 时由实体同步建表；
 * 本迁移供标准部署/测试库使用，全部 IF NOT EXISTS。
 * created_at 由服务端截断到秒，唯一索引负责同用户+路径+同秒去重。
 */
export class PageViews1794200000000 implements MigrationInterface {
  name = 'PageViews1794200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS page_views (
      id serial PRIMARY KEY,
      tenant_id int NOT NULL,
      user_id int NOT NULL,
      user_name varchar(60) NOT NULL,
      path varchar(300) NOT NULL,
      page_key varchar(60),
      created_at timestamptz NOT NULL,
      ip varchar(64),
      user_agent varchar(200)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_page_views_tenant_created ON page_views(tenant_id, created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_page_views_tenant_user_created ON page_views(tenant_id, user_id, created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_page_views_tenant_path ON page_views(tenant_id, path)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_page_views_user_path_second ON page_views(tenant_id, user_id, path, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS page_views');
  }
}
