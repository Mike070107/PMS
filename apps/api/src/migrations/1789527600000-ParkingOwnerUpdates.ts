import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingOwnerUpdates1789527600000 implements MigrationInterface {
  name = 'ParkingOwnerUpdates1789527600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "parking_owner_updates" (
        "id" SERIAL NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_by" integer,
        "tenant_id" integer NOT NULL,
        "database" varchar(80) NOT NULL,
        "external_owner_id" varchar(100) NOT NULL,
        "pms_user_id" integer,
        "idempotency_key" varchar(80) NOT NULL,
        "expected_values" jsonb NOT NULL,
        "requested_values" jsonb NOT NULL,
        "field_hints" jsonb NOT NULL DEFAULT '{}',
        "result_values" jsonb,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "attempt" integer NOT NULL DEFAULT 0,
        "requested_at" TIMESTAMPTZ NOT NULL,
        "completed_at" TIMESTAMPTZ,
        "lease_agent_key" varchar(80),
        "lease_expires_at" TIMESTAMPTZ,
        "last_error" varchar(500),
        CONSTRAINT "PK_parking_owner_updates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_parking_owner_updates_queue" ON "parking_owner_updates" ("tenant_id", "status", "created_at")');
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_parking_owner_updates_idempotency" ON "parking_owner_updates" ("tenant_id", "idempotency_key")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "parking_owner_updates"');
  }
}
