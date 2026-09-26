import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccountingCore1792972800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS finance_account_sets (
      id serial PRIMARY KEY, tenant_id int NOT NULL UNIQUE, name varchar(120) NOT NULL,
      accounting_standard varchar(40) NOT NULL DEFAULT 'small_enterprise', tax_jurisdiction varchar(40) NOT NULL DEFAULT 'shanghai',
      reporting_profile varchar(40) NOT NULL DEFAULT 'shanghai_small_enterprise', tax_filing_frequency varchar(30) NOT NULL DEFAULT 'quarterly_annual',
      required_reports jsonb NOT NULL DEFAULT '["balance_sheet","profit_statement","cash_flow_statement"]'::jsonb, current_period varchar(7) NOT NULL,
      closed_through varchar(7), currency varchar(3) NOT NULL DEFAULT 'CNY', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int)`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_accounts (
      id serial PRIMARY KEY, tenant_id int NOT NULL, code varchar(32) NOT NULL, name varchar(120) NOT NULL, level int NOT NULL DEFAULT 1,
      parent_id int, category varchar(20) NOT NULL, balance_direction varchar(10) NOT NULL, is_system boolean NOT NULL DEFAULT false,
      allow_posting boolean NOT NULL DEFAULT true, is_active boolean NOT NULL DEFAULT true, statement_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      CONSTRAINT uq_finance_account_code UNIQUE (tenant_id, code))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_finance_accounts_parent ON finance_accounts (tenant_id, parent_id)`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_opening_imports (
      id serial PRIMARY KEY, tenant_id int NOT NULL, period varchar(7) NOT NULL, original_name varchar(255) NOT NULL, status varchar(20) NOT NULL,
      total_rows int NOT NULL DEFAULT 0, imported_rows int NOT NULL DEFAULT 0, debit_total decimal(16,2) NOT NULL DEFAULT 0,
      credit_total decimal(16,2) NOT NULL DEFAULT 0, errors jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int)`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_opening_balances (
      id serial PRIMARY KEY, tenant_id int NOT NULL, period varchar(7) NOT NULL, account_id int NOT NULL,
      debit_amount decimal(16,2) NOT NULL DEFAULT 0, credit_amount decimal(16,2) NOT NULL DEFAULT 0, import_id int,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      CONSTRAINT uq_finance_opening_balance UNIQUE (tenant_id, period, account_id))`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_vouchers (
      id serial PRIMARY KEY, tenant_id int NOT NULL, voucher_no varchar(40) NOT NULL, voucher_date date NOT NULL, period varchar(7) NOT NULL,
      summary varchar(500) NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', source_type varchar(30), source_id int,
      total_debit decimal(16,2) NOT NULL DEFAULT 0, total_credit decimal(16,2) NOT NULL DEFAULT 0, revision int NOT NULL DEFAULT 1,
      reviewed_by int, reviewed_at timestamptz, posted_by int, posted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      CONSTRAINT uq_finance_voucher_no UNIQUE (tenant_id, period, voucher_no))`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_voucher_source ON finance_vouchers (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_voucher_lines (
      id serial PRIMARY KEY, tenant_id int NOT NULL, voucher_id int NOT NULL, line_no int NOT NULL, account_id int NOT NULL,
      summary varchar(500) NOT NULL, debit decimal(16,2) NOT NULL DEFAULT 0, credit decimal(16,2) NOT NULL DEFAULT 0,
      project_id int, counterparty_name varchar(200), cash_flow_item varchar(80), attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      CONSTRAINT uq_finance_voucher_line UNIQUE (tenant_id, voucher_id, line_no))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_finance_voucher_lines_account ON finance_voucher_lines (tenant_id, account_id)`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_voucher_audits (
      id serial PRIMARY KEY, tenant_id int NOT NULL, voucher_id int NOT NULL, action varchar(30) NOT NULL, description varchar(500) NOT NULL,
      snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_finance_voucher_audits_history ON finance_voucher_audits (tenant_id, voucher_id, created_at)`);
    await q.query(`CREATE TABLE IF NOT EXISTS finance_accounting_periods (
      id serial PRIMARY KEY, tenant_id int NOT NULL, period varchar(7) NOT NULL, status varchar(20) NOT NULL DEFAULT 'open',
      closed_at timestamptz, closed_by int, validation_snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), created_by int, updated_by int,
      CONSTRAINT uq_finance_accounting_period UNIQUE (tenant_id, period))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS finance_accounting_periods, finance_voucher_audits, finance_voucher_lines, finance_vouchers, finance_opening_balances, finance_opening_imports, finance_accounts, finance_account_sets`);
  }
}
