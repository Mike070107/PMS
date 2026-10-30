import { MigrationInterface, QueryRunner } from 'typeorm';

/** 房产归档（软删除可恢复）：houses.archived_at 非空=已归档。生产 synchronize 会自动建列，这条给 dev 库兜底。 */
export class HouseArchive1792900000000 implements MigrationInterface {
  name = 'HouseArchive1792900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS houses ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS houses DROP COLUMN IF EXISTS archived_at`);
  }
}
