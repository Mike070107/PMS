import { MigrationInterface, QueryRunner } from 'typeorm';

/** 指标考核费项：默认物业费，允许按费项设置（property/berth/parking/other）。 */
export class CollectionTargetFeeCode1795100000000 implements MigrationInterface {
  name = 'CollectionTargetFeeCode1795100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query("ALTER TABLE collection_targets ADD COLUMN IF NOT EXISTS fee_code varchar(20) NOT NULL DEFAULT 'property'");
    await q.query("ALTER TABLE collection_targets DROP CONSTRAINT IF EXISTS ck_collection_targets_fee_code");
    await q.query("ALTER TABLE collection_targets ADD CONSTRAINT ck_collection_targets_fee_code CHECK (fee_code IN ('property','berth','parking','other'))");
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE collection_targets DROP CONSTRAINT IF EXISTS ck_collection_targets_fee_code');
    await q.query('ALTER TABLE collection_targets DROP COLUMN IF EXISTS fee_code');
  }
}
