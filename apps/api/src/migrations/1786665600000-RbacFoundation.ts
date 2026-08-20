import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 项目首条 migration：多租户 RBAC 基建（设计见 docs/rbac-design.md）。
 *
 * 历史包袱：此前 schema 全靠 DB_SYNCHRONIZE 生成，所以这条不重建存量表，
 * 只负责新增对象，且全部 IF NOT EXISTS —— 在 synchronize 已建好新表的开发库上
 * 重复执行也安全。生产执行方式：pnpm --filter @pms/api migration:run
 */
export class RbacFoundation1786665600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 物业管理处
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS management_offices (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        name varchar(120) NOT NULL,
        remark varchar(255),
        enabled boolean NOT NULL DEFAULT true
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_mgmt_offices_tenant ON management_offices (tenant_id)`,
    );

    // 后台角色
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        name varchar(60) NOT NULL,
        remark varchar(255),
        data_scope varchar(20) NOT NULL DEFAULT 'all',
        built_in boolean NOT NULL DEFAULT false,
        enabled boolean NOT NULL DEFAULT true
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_tenant_name ON roles (tenant_id, name)`,
    );

    // 角色 × 页面 三档权限
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        role_id int NOT NULL,
        page_key varchar(40) NOT NULL,
        can_view boolean NOT NULL DEFAULT false,
        can_edit boolean NOT NULL DEFAULT false,
        can_delete boolean NOT NULL DEFAULT false
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_role_perms_tenant ON role_permissions (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_role_perms_role_page ON role_permissions (role_id, page_key)`,
    );

    // 角色数据范围明细
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS role_scopes (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        role_id int NOT NULL,
        office_id int,
        community_id int
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_role_scopes_tenant ON role_scopes (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_role_scopes_role ON role_scopes (role_id)`,
    );

    // 用户 ↔ 角色
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        user_id int NOT NULL,
        role_id int NOT NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_user ON user_roles (tenant_id, user_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_user_role ON user_roles (user_id, role_id)`,
    );

    // 平台操作审计
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform_logs (
        id SERIAL PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        actor_user_id int NOT NULL,
        action varchar(40) NOT NULL,
        target_tenant_id int,
        detail jsonb
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_platform_logs_actor ON platform_logs (actor_user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_platform_logs_tenant ON platform_logs (target_tenant_id)`,
    );

    // 存量表新增列
    await queryRunner.query(
      `ALTER TABLE communities ADD COLUMN IF NOT EXISTS office_id int`,
    );
    await queryRunner.query(
      `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enabled_pages jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS enabled_pages`);
    await queryRunner.query(`ALTER TABLE communities DROP COLUMN IF EXISTS office_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS platform_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_roles`);
    await queryRunner.query(`DROP TABLE IF EXISTS role_scopes`);
    await queryRunner.query(`DROP TABLE IF EXISTS role_permissions`);
    await queryRunner.query(`DROP TABLE IF EXISTS roles`);
    await queryRunner.query(`DROP TABLE IF EXISTS management_offices`);
  }
}
