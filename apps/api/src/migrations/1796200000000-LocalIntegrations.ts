import { MigrationInterface, QueryRunner } from 'typeorm';
export class LocalIntegrations1796200000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS local_integrations (
      id serial PRIMARY KEY, tenant_id int NOT NULL, key varchar(80) NOT NULL UNIQUE,
      name varchar(100) NOT NULL, kind varchar(30) NOT NULL, token_hash varchar(64) NOT NULL,
      enabled boolean NOT NULL DEFAULT true, resources jsonb NOT NULL DEFAULT '[]', ready jsonb NOT NULL DEFAULT '[]',
      version varchar(30) NOT NULL DEFAULT 'pending', last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      UNIQUE(tenant_id, name))`);
    await q.query(`CREATE TABLE IF NOT EXISTS local_integration_tasks (
      id serial PRIMARY KEY, tenant_id int NOT NULL, integration_key varchar(80) NOT NULL,
      resource_id varchar(80) NOT NULL, operation varchar(50) NOT NULL, revision int NOT NULL DEFAULT 1,
      idempotency_key varchar(80) NOT NULL, command jsonb NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending',
      lease_token varchar(64), lease_expires_at timestamptz, result jsonb, completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      UNIQUE(tenant_id, integration_key, idempotency_key))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_local_integration_task_pending ON local_integration_tasks (tenant_id, integration_key, status, id)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS local_integration_tasks');
    await q.query('DROP TABLE IF EXISTS local_integrations');
  }
}
