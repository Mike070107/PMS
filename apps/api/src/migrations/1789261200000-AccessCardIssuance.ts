import { MigrationInterface, QueryRunner } from 'typeorm';

/** 任意工作站发卡、二期门禁激活及 .80 旧库同步的可续跑任务模型。 */
export class AccessCardIssuance1789261200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_agents (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        agent_key varchar(80) NOT NULL,
        kind varchar(30) NOT NULL,
        name varchar(100) NOT NULL,
        version varchar(30) NOT NULL,
        token_hash varchar(64) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        status varchar(30) NOT NULL DEFAULT 'offline',
        capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_seen_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_access_card_agent_key UNIQUE (tenant_id, agent_key)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_issue_batches (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        house_id integer NOT NULL REFERENCES houses(id),
        community_id integer NOT NULL,
        building_id integer NOT NULL,
        legacy_room_key varchar(100) NOT NULL,
        address_snapshot varchar(255) NOT NULL,
        project_phase varchar(20) NOT NULL,
        access_system varchar(30) NULL,
        quantity integer NOT NULL DEFAULT 1,
        target_building_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        workstation_id varchar(80) NULL,
        status varchar(30) NOT NULL DEFAULT 'waiting_for_card',
        current_sequence integer NOT NULL DEFAULT 1,
        idempotency_key varchar(80) NOT NULL UNIQUE,
        completed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT ck_access_card_batch_quantity CHECK (quantity BETWEEN 1 AND 6)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_access_card_batches_house
        ON access_card_issue_batches (tenant_id, house_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_issue_items (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        batch_id integer NOT NULL REFERENCES access_card_issue_batches(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        card_status varchar(40) NOT NULL DEFAULT 'waiting_for_card',
        access_status varchar(40) NOT NULL,
        legacy_sync_status varchar(40) NOT NULL DEFAULT 'pending',
        ic_card_no varchar(40) NULL,
        wg_card_no varchar(20) NULL,
        legacy_person_id integer NULL,
        legacy_person_no varchar(40) NULL,
        legacy_house_sequence integer NULL,
        controller_results jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_error_ref varchar(20) NULL,
        last_error_message varchar(500) NULL,
        lease_agent_key varchar(80) NULL,
        lease_expires_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0,
        card_completed_at timestamptz NULL,
        access_completed_at timestamptz NULL,
        legacy_synced_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_access_card_item_sequence UNIQUE (batch_id, sequence)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_access_card_item_ic
        ON access_card_issue_items (tenant_id, ic_card_no)
        WHERE ic_card_no IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_access_card_item_wg
        ON access_card_issue_items (tenant_id, wg_card_no)
        WHERE wg_card_no IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS access_card_legacy_snapshots (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        room_key varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        history jsonb NOT NULL DEFAULT '[]'::jsonb,
        issued_count integer NOT NULL DEFAULT 0,
        next_sequence integer NOT NULL DEFAULT 1,
        requested_at timestamptz NOT NULL,
        refreshed_at timestamptz NULL,
        lease_agent_key varchar(80) NULL,
        lease_expires_at timestamptz NULL,
        last_error varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_access_card_legacy_snapshot UNIQUE (tenant_id, room_key)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS access_card_legacy_snapshots');
    await queryRunner.query('DROP TABLE IF EXISTS access_card_issue_items');
    await queryRunner.query('DROP TABLE IF EXISTS access_card_issue_batches');
    await queryRunner.query('DROP TABLE IF EXISTS access_card_agents');
  }
}
