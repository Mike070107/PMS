import { MigrationInterface, QueryRunner } from 'typeorm';

/** 收费指标：按小区、年度保存年度/月度目标（单位分）。 */
export class CollectionTargets1794900000000 implements MigrationInterface {
  name = 'CollectionTargets1794900000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS collection_targets (
        id bigserial PRIMARY KEY,
        tenant_id int NOT NULL,
        community_id int NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        year int NOT NULL,
        annual_cents bigint NOT NULL DEFAULT 0,
        month_cents jsonb,
        created_by int,
        updated_by int,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_collection_targets_tenant_community_year UNIQUE (tenant_id, community_id, year)
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_collection_targets_tenant_year ON collection_targets(tenant_id, year)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS collection_targets');
  }
}
