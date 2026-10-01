import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingOperations1789534800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS parking_operations (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL,
        kind varchar(30) NOT NULL,
        database varchar(80) NOT NULL,
        idempotency_key varchar(100) NOT NULL,
        source_record_id varchar(100) NULL,
        pms_user_id integer NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        expected jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        attempt integer NOT NULL DEFAULT 0,
        requested_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL,
        lease_agent_key varchar(80) NULL,
        lease_expires_at timestamptz NULL,
        last_error varchar(500) NULL,
        rollback_of_operation_id integer NULL,
        CONSTRAINT parking_operations_idempotency_uq UNIQUE (tenant_id, idempotency_key)
      )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS parking_operations_status_idx ON parking_operations (tenant_id, status, created_at)');
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS parking_operations');
  }
}
