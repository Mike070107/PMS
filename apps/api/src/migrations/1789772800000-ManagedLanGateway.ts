import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManagedLanGateway1789772800000 implements MigrationInterface {
  name = 'ManagedLanGateway1789772800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "lan_gateway_agents" (
        "id" SERIAL NOT NULL,
        "tenant_id" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_by" integer,
        "name" character varying(120) NOT NULL,
        "device_key" character varying(80) NOT NULL,
        "token_hash" character varying(64),
        "install_code_hash" character varying(64),
        "install_code_expires_at" TIMESTAMP WITH TIME ZONE,
        "enrolled_at" TIMESTAMP WITH TIME ZONE,
        "status" character varying(30) NOT NULL DEFAULT 'pending',
        "version" character varying(30),
        "computer_name" character varying(120),
        "desired_revision" integer NOT NULL DEFAULT 0,
        "applied_revision" integer NOT NULL DEFAULT 0,
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "last_error" character varying(1000),
        "enabled" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_lan_gateway_agents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_lan_gateway_agents_device_key" UNIQUE ("device_key")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_lan_gateway_agents_tenant_name" ON "lan_gateway_agents" ("tenant_id", "name")');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "agent_id" integer');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "gateway_port" integer');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "publish_status" character varying(30) NOT NULL DEFAULT \'draft\'');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "desired_revision" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "applied_revision" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "external_access_apps" ADD "origin_checked_at" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_external_access_apps_gateway_port" ON "external_access_apps" ("gateway_port") WHERE "gateway_port" IS NOT NULL');
    await queryRunner.query('CREATE INDEX "IDX_external_access_apps_agent" ON "external_access_apps" ("tenant_id", "agent_id")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_external_access_apps_agent"');
    await queryRunner.query('DROP INDEX "UQ_external_access_apps_gateway_port"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "origin_checked_at"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "applied_revision"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "desired_revision"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "publish_status"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "gateway_port"');
    await queryRunner.query('ALTER TABLE "external_access_apps" DROP COLUMN "agent_id"');
    await queryRunner.query('DROP TABLE "lan_gateway_agents"');
  }
}
