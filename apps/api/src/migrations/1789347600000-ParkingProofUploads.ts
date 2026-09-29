import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingProofUploads1789347600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS parking_proof_uploads (
        id SERIAL PRIMARY KEY,
        tenant_id integer NOT NULL,
        token_hash varchar(64) NOT NULL UNIQUE,
        plate varchar(20) NOT NULL,
        owner_id varchar(50) NULL,
        requested_by integer NOT NULL,
        expires_at timestamptz NOT NULL,
        opened_at timestamptz NULL,
        submitted_at timestamptz NULL,
        object_key varchar(500) NULL,
        file_name varchar(255) NULL,
        content_type varchar(100) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by integer NULL,
        updated_by integer NULL
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_proof_tenant_plate ON parking_proof_uploads (tenant_id, plate)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_parking_proof_expires ON parking_proof_uploads (expires_at)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS parking_proof_uploads');
  }
}
