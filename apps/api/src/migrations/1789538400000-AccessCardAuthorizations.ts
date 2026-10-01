import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccessCardAuthorizations1789538400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_authorizations (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        house_id integer NOT NULL,
        history_row_id integer NOT NULL,
        room_key varchar(100) NOT NULL,
        ic_card_no varchar(40) NULL,
        wg_card_no varchar(40) NOT NULL,
        target_buildings jsonb NOT NULL DEFAULT '[]'::jsonb,
        controller_results jsonb NOT NULL DEFAULT '[]'::jsonb,
        idempotency_key varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        attempt integer NOT NULL DEFAULT 0,
        requested_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL,
        lease_agent_key varchar(80) NULL,
        lease_expires_at timestamptz NULL,
        last_error varchar(500) NULL,
        CONSTRAINT access_card_authorizations_idempotency_uq UNIQUE (tenant_id, idempotency_key)
      )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS access_card_authorizations_status_idx ON access_card_authorizations (tenant_id, status, created_at)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS access_card_authorizations');
  }
}
