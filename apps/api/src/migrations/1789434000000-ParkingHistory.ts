import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingHistory1789434000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS parking_history (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        event_type varchar(30) NOT NULL,
        source varchar(20) NOT NULL,
        database varchar(80) NULL,
        source_record_id varchar(100) NULL,
        pms_user_id integer NULL,
        external_owner_id varchar(100) NULL,
        plate_before varchar(20) NULL,
        plate_after varchar(20) NULL,
        summary varchar(300) NOT NULL,
        changes jsonb NOT NULL DEFAULT '[]'::jsonb,
        operator_user_id integer NULL,
        detected_by_query_id integer NULL,
        occurred_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_history_user ON parking_history (tenant_id, pms_user_id, occurred_at DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_history_owner ON parking_history (tenant_id, database, external_owner_id, occurred_at DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_history_plate_after ON parking_history (tenant_id, plate_after, occurred_at DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_history_plate_before ON parking_history (tenant_id, plate_before, occurred_at DESC)');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS parking_record_snapshots (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        database varchar(80) NOT NULL,
        source_record_id varchar(100) NOT NULL,
        values jsonb NOT NULL,
        observed_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        CONSTRAINT uq_parking_record_snapshot UNIQUE (tenant_id, database, source_record_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS parking_record_snapshots');
    await queryRunner.query('DROP TABLE IF EXISTS parking_history');
  }
}
