import { MigrationInterface, QueryRunner } from 'typeorm';

/** 通用内网应用发布、用户授权及 Cloudflare Access OIDC。 */
export class ExternalAccessGateway1789520400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS purpose varchar(30) NOT NULL DEFAULT 'admin'`,
    );
    await queryRunner.query(
      `ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS oidc_request jsonb NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS oidc_authorization_codes (
        id SERIAL PRIMARY KEY,
        code_hash char(64) NOT NULL UNIQUE,
        user_id integer NOT NULL REFERENCES users(id),
        client_id varchar(160) NOT NULL,
        redirect_uri varchar(500) NOT NULL,
        nonce varchar(200) NULL,
        code_challenge varchar(128) NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_oidc_authorization_codes_expires ON oidc_authorization_codes (expires_at)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS external_access_apps (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL REFERENCES tenants(id),
        slug varchar(60) NOT NULL,
        name varchar(120) NOT NULL,
        public_hostname varchar(255) NOT NULL UNIQUE,
        origin_url varchar(500) NOT NULL,
        entry_path varchar(1000) NOT NULL DEFAULT '/',
        session_duration varchar(20) NOT NULL DEFAULT '8h',
        enabled boolean NOT NULL DEFAULT true,
        cloudflare_app_id varchar(64) NULL,
        cloudflare_policy_id varchar(64) NULL,
        cloudflare_dns_record_id varchar(64) NULL,
        last_synced_at timestamptz NULL,
        last_sync_error varchar(1000) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_external_access_app_slug UNIQUE (tenant_id, slug)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS external_access_grants (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL REFERENCES tenants(id),
        app_id integer NOT NULL REFERENCES external_access_apps(id) ON DELETE CASCADE,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_external_access_grant UNIQUE (app_id, user_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_external_access_grants_user ON external_access_grants (tenant_id, user_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS external_access_grants');
    await queryRunner.query('DROP TABLE IF EXISTS external_access_apps');
    await queryRunner.query('DROP TABLE IF EXISTS oidc_authorization_codes');
    await queryRunner.query('ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS oidc_request');
    await queryRunner.query('ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS purpose');
  }
}
