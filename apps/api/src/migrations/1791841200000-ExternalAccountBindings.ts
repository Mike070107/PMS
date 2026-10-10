import { MigrationInterface, QueryRunner } from 'typeorm';

/** 公寓系统首次账密绑定与后续网关 Bearer 代登。 */
export class ExternalAccountBindings1791841200000 implements MigrationInterface {
  name = 'ExternalAccountBindings1791841200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "external_access_apps" ADD COLUMN IF NOT EXISTS "login_adapter" varchar(30) NOT NULL DEFAULT 'none'`);
    await queryRunner.query(`ALTER TABLE "external_access_apps" ADD COLUMN IF NOT EXISTS "login_path" varchar(255)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "external_account_bindings" (
        "id" SERIAL NOT NULL,
        "tenant_id" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_by" integer,
        "app_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "remote_user_id" varchar(120) NOT NULL,
        "remote_username" varchar(120) NOT NULL,
        "remote_display_name" varchar(120),
        "credential_payload" text NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_error" varchar(500),
        CONSTRAINT "PK_external_account_bindings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_external_account_binding_user" ON "external_account_bindings" ("tenant_id", "app_id", "user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_external_account_binding_remote" ON "external_account_bindings" ("app_id", "remote_user_id") WHERE "status" = 'active'`);

    // 首个适配对象：已现场验证 POST /api/login 返回 Bearer JWT。
    await queryRunner.query(`
      UPDATE "external_access_apps"
      SET "login_adapter" = 'bearer_json', "login_path" = '/api/login', "updated_at" = now()
      WHERE "public_hostname" = 'wyglxt.prsznh.cn'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_external_account_binding_remote"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_external_account_binding_user"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "external_account_bindings"`);
    await queryRunner.query(`ALTER TABLE "external_access_apps" DROP COLUMN IF EXISTS "login_path"`);
    await queryRunner.query(`ALTER TABLE "external_access_apps" DROP COLUMN IF EXISTS "login_adapter"`);
  }
}
