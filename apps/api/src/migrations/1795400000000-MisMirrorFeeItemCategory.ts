import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MIS 镜像收费项目增加分类（源 SETUPSFXM.收费类别）。
 *
 * 旧报表筛选面板按「代收费 / 其它 / 日常收费 / 停车收费」给 16 个收费项目分组；
 * 现有镜像只有 fee_code/fee_name，缺分类。本迁移只加列；
 * 下一次 5 分钟增量同步（syncSmallDimensions）会自动回填，不需要全量重灌。
 * 生产 DB_SYNCHRONIZE 不处理 mis_mirror_* 表，上线前需手工执行同一句 ALTER。
 */
export class MisMirrorFeeItemCategory1795400000000 implements MigrationInterface {
  name = 'MisMirrorFeeItemCategory1795400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_mirror_fee_item ADD COLUMN IF NOT EXISTS category varchar(30)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_mirror_fee_item DROP COLUMN IF EXISTS category');
  }
}
