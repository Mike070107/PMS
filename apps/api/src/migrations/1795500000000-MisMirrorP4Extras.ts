import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P4-A 统计汇总补充镜像：
 * - 票据 / 票据开票数据 / 票据核销记录 / 签报情况表 / 签报减免信息 五张只读镜像表；
 * - mis_mirror_bill 增加 WYZJ 的 收入、票据入库单编号、发票号码、凭证号码 四列（收款汇总/清单票据列用）。
 *
 * 全部幂等（CREATE TABLE/INDEX IF NOT EXISTS、ADD COLUMN IF NOT EXISTS），可重复执行。
 * 生产 DB_SYNCHRONIZE 不处理 mis_mirror_* 表，上线前需手工执行同一段 SQL（见交付报告）。
 */
export class MisMirrorP4Extras1795500000000 implements MigrationInterface {
  name = 'MisMirrorP4Extras1795500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_ticket (
      id bigint PRIMARY KEY,
      ticket_no varchar(60),
      warehouse_no varchar(60),
      office_code varchar(10),
      issue_date date,
      payer varchar(500),
      amount_cents bigint,
      tax_cents bigint,
      pre_issue boolean,
      receipt_date date,
      issuer varchar(150),
      payee varchar(150),
      void_date date,
      void_reason varchar(150),
      writeoff_date date,
      payment_method varchar(60),
      refund_date date,
      zh_id bigint,
      customer_name varchar(150),
      address varchar(500),
      invoice_no varchar(60),
      invoice_code varchar(60),
      type varchar(60),
      source_updated_at timestamptz,
      synced_at timestamptz DEFAULT now()
    )`);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_ticket_office_issue ON mis_mirror_ticket(office_code, issue_date)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_ticket_ticket_no ON mis_mirror_ticket(ticket_no)');

    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_ticket_item (
      id bigint PRIMARY KEY,
      ticket_id bigint,
      ticket_no varchar(60),
      item_name varchar(60),
      project varchar(60),
      amount_cents bigint,
      tax_cents bigint,
      fee_code varchar(30),
      warehouse_no varchar(60),
      receipt_voucher_no varchar(60),
      non_daily boolean,
      tax_rate numeric(10,4),
      synced_at timestamptz DEFAULT now()
    )`);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_ticket_item_ticket ON mis_mirror_ticket_item(ticket_id)');

    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_ticket_writeoff (
      id bigint PRIMARY KEY,
      writeoff_no varchar(60),
      office_code varchar(10),
      writeoff_date date,
      quantity numeric(14,2),
      issued_qty numeric(14,2),
      void_qty numeric(14,2),
      pre_issue_qty numeric(14,2),
      unused_qty numeric(14,2),
      issued_amount_cents bigint,
      pre_issue_amount_cents bigint,
      writeoff_user varchar(60),
      synced_at timestamptz DEFAULT now()
    )`);

    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_signoff (
      id bigint PRIMARY KEY,
      doc_no varchar(60),
      title varchar(500),
      type varchar(60),
      detail varchar(100),
      office_code varchar(10),
      reason text,
      zh_id bigint,
      draft_date date,
      approve_date date,
      result varchar(500),
      voided boolean,
      ended boolean,
      adjust_amount_cents bigint,
      fee_code varchar(60),
      nature varchar(60),
      source_updated_at timestamptz,
      synced_at timestamptz DEFAULT now()
    )`);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_signoff_draft ON mis_mirror_signoff(draft_date)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_signoff_doc ON mis_mirror_signoff(doc_no)');

    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_relief (
      id bigint PRIMARY KEY,
      doc_no varchar(60),
      zh_id bigint,
      fee_code varchar(30),
      fee_name varchar(60),
      old_receivable_cents bigint,
      receivable_cents bigint,
      relief_cents bigint,
      relief_start_date date,
      relief_end_date date,
      relief_date date,
      method varchar(60),
      synced_at timestamptz DEFAULT now()
    )`);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_relief_date ON mis_mirror_relief(relief_date)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_relief_doc ON mis_mirror_relief(doc_no)');

    await q.query('ALTER TABLE mis_mirror_bill ADD COLUMN IF NOT EXISTS income_cents bigint');
    await q.query('ALTER TABLE mis_mirror_bill ADD COLUMN IF NOT EXISTS receipt_warehouse_no varchar(60)');
    await q.query('ALTER TABLE mis_mirror_bill ADD COLUMN IF NOT EXISTS invoice_no varchar(60)');
    await q.query('ALTER TABLE mis_mirror_bill ADD COLUMN IF NOT EXISTS receipt_voucher_no varchar(60)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE mis_mirror_bill DROP COLUMN IF EXISTS receipt_voucher_no');
    await q.query('ALTER TABLE mis_mirror_bill DROP COLUMN IF EXISTS invoice_no');
    await q.query('ALTER TABLE mis_mirror_bill DROP COLUMN IF EXISTS receipt_warehouse_no');
    await q.query('ALTER TABLE mis_mirror_bill DROP COLUMN IF EXISTS income_cents');
    await q.query('DROP TABLE IF EXISTS mis_mirror_relief');
    await q.query('DROP TABLE IF EXISTS mis_mirror_signoff');
    await q.query('DROP TABLE IF EXISTS mis_mirror_ticket_writeoff');
    await q.query('DROP TABLE IF EXISTS mis_mirror_ticket_item');
    await q.query('DROP TABLE IF EXISTS mis_mirror_ticket');
  }
}
