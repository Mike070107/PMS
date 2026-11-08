import { MigrationInterface, QueryRunner } from 'typeorm';

/** 收费指标支持小区组：保留旧 community_id，新增 community_ids；旧数据回填为单小区组。 */
export class CollectionTargetGroups1795000000000 implements MigrationInterface {
  name = 'CollectionTargetGroups1795000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE collection_targets ADD COLUMN IF NOT EXISTS community_ids int[]');
    await q.query('UPDATE collection_targets SET community_ids=ARRAY[community_id] WHERE community_ids IS NULL');
    await q.query('ALTER TABLE collection_targets ALTER COLUMN community_ids SET NOT NULL');
    await q.query('CREATE INDEX IF NOT EXISTS ix_collection_targets_community_ids ON collection_targets USING GIN(community_ids)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS ix_collection_targets_community_ids');
    await q.query('ALTER TABLE collection_targets DROP COLUMN IF EXISTS community_ids');
  }
}
