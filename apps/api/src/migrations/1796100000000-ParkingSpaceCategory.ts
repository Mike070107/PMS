import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 车位档案增加独立、可空的「车位类别」。
 *
 * 旧数据保持 NULL（未知），不从备注/车牌等历史文本批量推断；运行时不回填。
 * 业务值 property / rental / vacant 由 DTO/Service 校验，非法值 400；
 * 数据库层保持 nullable，避免历史/未来类别被 CHECK 约束卡住。
 *
 * 依赖：parking_spaces 表必须已存在（本仓库没有创建该表的 migration，
 * 生产为 synchronize 建表；本地/runner 需先建旧 schema）。
 */
export class ParkingSpaceCategory1796100000000 implements MigrationInterface {
  name = 'ParkingSpaceCategory1796100000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE parking_spaces ADD COLUMN IF NOT EXISTS category varchar(20)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE parking_spaces DROP COLUMN IF EXISTS category');
  }
}
