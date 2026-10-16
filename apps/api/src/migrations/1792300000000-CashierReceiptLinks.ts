import { MigrationInterface, QueryRunner } from 'typeorm';

/** 只回填可唯一匹配的本系统旧红冲，不猜测旧库缺失的关联，不修改金额/发生日。 */
export class CashierReceiptLinks1792300000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE fee_bills ADD COLUMN original_receipt_no varchar(60), ADD COLUMN reversal_receipt_no varchar(60)`);
    await q.query(`WITH receipts AS (
      SELECT tenant_id, house_id, receipt_no, SUM(amount_cents) amount,
        MIN(status) status, MAX(remark) remark, MIN(paid_at) paid_at
      FROM fee_bills WHERE receipt_no IS NOT NULL GROUP BY tenant_id, house_id, receipt_no
    ), candidates AS (
      SELECT r.tenant_id, r.house_id, r.receipt_no reversal, o.receipt_no original,
        COUNT(*) OVER (PARTITION BY r.tenant_id, r.house_id, o.receipt_no) matches
      FROM receipts r JOIN receipts o ON o.tenant_id=r.tenant_id AND o.house_id=r.house_id
        AND o.receipt_no=substring(r.remark from '^红冲 ([^；]+)')
      WHERE r.amount < 0 AND o.amount=-r.amount AND o.status='refunded' AND r.status='refunded'
        AND o.paid_at <= r.paid_at
    ), pairs AS (SELECT * FROM candidates WHERE matches=1)
    UPDATE fee_bills f SET
      original_receipt_no=CASE WHEN f.receipt_no=p.reversal THEN p.original ELSE NULL END,
      reversal_receipt_no=CASE WHEN f.receipt_no=p.original THEN p.reversal ELSE NULL END
    FROM pairs p WHERE f.tenant_id=p.tenant_id AND f.house_id=p.house_id AND f.receipt_no IN(p.original,p.reversal)`);
    await q.query(`CREATE INDEX idx_fee_receipt_links ON fee_bills(tenant_id, receipt_no)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX idx_fee_receipt_links');
    await q.query('ALTER TABLE fee_bills DROP COLUMN original_receipt_no, DROP COLUMN reversal_receipt_no');
  }
}
