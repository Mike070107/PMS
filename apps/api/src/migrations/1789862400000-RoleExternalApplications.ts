import { MigrationInterface, QueryRunner } from 'typeorm';

/** 把内网应用准入从发布页逐人授权收口到业务角色与权限模板。 */
export class RoleExternalApplications1789862400000 implements MigrationInterface {
  name = 'RoleExternalApplications1789862400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "external_app_ids" integer[] NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_templates" ADD COLUMN IF NOT EXISTS "external_app_ids" integer[] NOT NULL DEFAULT '{}'`,
    );
    // 旧表允许绕过角色给单个用户开特例。产品收口后直接移除，
    // 不迁移其数据，避免上线后还有看不见的隐形授权。
    await queryRunner.query('DROP TABLE IF EXISTS "external_access_grants"');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "external_access_grants" (
        "id" SERIAL PRIMARY KEY,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
        "app_id" integer NOT NULL REFERENCES "external_access_apps"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer NULL,
        "updated_by" integer NULL,
        CONSTRAINT "uq_external_access_grant" UNIQUE ("app_id", "user_id")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "idx_external_access_grants_user" ON "external_access_grants" ("tenant_id", "user_id")',
    );
    await queryRunner.query('ALTER TABLE "role_templates" DROP COLUMN IF EXISTS "external_app_ids"');
    await queryRunner.query('ALTER TABLE "roles" DROP COLUMN IF EXISTS "external_app_ids"');
  }
}
