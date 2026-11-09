import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MIS 镜像账单增加行级房屋性质（源 WYZJ.FWXZ_DH）。
 *
 * 旧报表「房屋性质」过滤用的是收费明细行发生时的性质，而不是室表当前性质；
 * 只镜像 room.nature 会把历史上按「06 空房」计费的欠费算成商铺/配套用房。
 * 本迁移只加列；历史行由管理员触发镜像全量重灌（POST /fees/mis/mirror/reload）回填。
 * 生产 DB_SYNCHRONIZE 不会处理 mis_mirror_* 表，上线前需手工执行同一句 ALTER（见发布单）。
 */
export class MisMirrorBillNature1795300000000 implements MigrationInterface {
  name = 'MisMirrorBillNature1795300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_mirror_bill ADD COLUMN IF NOT EXISTS nature_code varchar(20)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_mirror_bill DROP COLUMN IF EXISTS nature_code');
  }
}
