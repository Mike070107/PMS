import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingFamilyReview1792014000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE parking_proof_uploads
      ADD COLUMN review_status varchar(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN review_reason text NULL,
      ADD COLUMN reviewed_at timestamptz NULL,
      ADD COLUMN reviewed_by integer NULL,
      ADD COLUMN registration_id integer NULL,
      ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`UPDATE parking_proof_uploads p SET registration_id = o.id FROM parking_operations o
      WHERE p.tenant_id = o.tenant_id AND p.plate = o.payload->>'plate' AND o.kind = 'add_vehicle'
      AND o.payload->>'requiresProofReview' = 'true'
      AND o.id = (SELECT max(x.id) FROM parking_operations x WHERE x.tenant_id = o.tenant_id
        AND x.payload->>'plate' = p.plate AND x.kind = 'add_vehicle')`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE parking_proof_uploads DROP COLUMN files, DROP COLUMN registration_id,
      DROP COLUMN reviewed_by, DROP COLUMN reviewed_at, DROP COLUMN review_reason, DROP COLUMN review_status`);
  }
}
