import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 年度/月报表审计日期与线上收费标识补齐：
 * - `mis_mirror_bill` 增加 WYZJ 的 记账日期 ZJ_Jzrq、调整日期 ZJ_TZRQ、变动日期 ZJ_Bdrq
 *   三列（旧「收费月报表」「综合月报表B」「欠收/溢收」在截止判断里用到）；
 * - 增加 交易订单号、商户订单号 两列（线上收费查询/对账用）。
 *
 * 全部幂等（ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS、DROP COLUMN IF EXISTS），可重复执行。
 * 生产 `DB_SYNCHRONIZE` 不处理 `mis_mirror_*` 表：上线时需手工执行同一段 SQL，并重灌一次账单镜像才会回填历史行。
 */
export class MisMirrorBillAuditDates1795800000000 implements MigrationInterface {
  name = 'MisMirrorBillAuditDates1795800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mis_mirror_bill
      ADD COLUMN IF NOT EXISTS book_date date,
      ADD COLUMN IF NOT EXISTS adjust_date date,
      ADD COLUMN IF NOT EXISTS change_date date,
      ADD COLUMN IF NOT EXISTS trade_order_no varchar(100),
      ADD COLUMN IF NOT EXISTS merchant_order_no varchar(100)`);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_bill_book_date ON mis_mirror_bill(book_date)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS idx_mis_mirror_bill_book_date');
    await q.query(`ALTER TABLE mis_mirror_bill
      DROP COLUMN IF EXISTS book_date,
      DROP COLUMN IF EXISTS adjust_date,
      DROP COLUMN IF EXISTS change_date,
      DROP COLUMN IF EXISTS trade_order_no,
      DROP COLUMN IF EXISTS merchant_order_no`);
  }
}
