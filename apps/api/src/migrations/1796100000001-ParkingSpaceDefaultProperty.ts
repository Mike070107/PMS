import { MigrationInterface, QueryRunner } from 'typeorm';

/** 用户明确：两库未设置默认产权；精确旧备注租赁沿用，已设置类别一律不覆盖。 */
export class ParkingSpaceDefaultProperty1796100000001 implements MigrationInterface {
  name = 'ParkingSpaceDefaultProperty1796100000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query("ALTER TABLE parking_spaces ALTER COLUMN category SET DEFAULT 'property'");
    await q.query(`UPDATE parking_spaces
      SET category = CASE WHEN btrim(note) = '租赁车位' THEN 'rental' ELSE 'property' END
      WHERE garage IN ('main', 'civil') AND (category IS NULL OR btrim(category) = '')`);
  }

  async down(q: QueryRunner): Promise<void> {
    // 回滚默认值，不盲目把现有产权/租赁改回未知；历史回填恢复须使用发布前快照逐ID核对。
    await q.query('ALTER TABLE parking_spaces ALTER COLUMN category DROP DEFAULT');
  }
}
