import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccessCardLegacyDuplicateCheck1789347600000 implements MigrationInterface {
  name = 'AccessCardLegacyDuplicateCheck1789347600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_legacy_card_checks (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        item_id integer NOT NULL REFERENCES access_card_issue_items(id) ON DELETE CASCADE,
        ic_card_no varchar(40) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        matches jsonb NOT NULL DEFAULT '[]'::jsonb,
        requested_at timestamptz NOT NULL,
        checked_at timestamptz NULL,
        lease_agent_key varchar(80) NULL,
        lease_expires_at timestamptz NULL,
        last_error varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_access_card_legacy_card_check_item UNIQUE (item_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_access_card_legacy_card_check_queue
        ON access_card_legacy_card_checks (tenant_id, status, requested_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS access_card_legacy_card_checks');
  }
}
