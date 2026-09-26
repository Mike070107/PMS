import { MigrationInterface, QueryRunner } from 'typeorm';

export class InvoiceRecognitionVerificationAndTaxImport1790377200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE finance_invoices
        ALTER COLUMN source TYPE varchar(30),
        ALTER COLUMN object_key DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS tax_amount decimal(14,2) NULL,
        ADD COLUMN IF NOT EXISTS seller_tax_no varchar(40) NULL,
        ADD COLUMN IF NOT EXISTS buyer_tax_no varchar(40) NULL,
        ADD COLUMN IF NOT EXISTS recognition_status varchar(30) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS recognition_source varchar(50) NULL,
        ADD COLUMN IF NOT EXISTS recognition_confidence decimal(5,2) NULL,
        ADD COLUMN IF NOT EXISTS verification_status varchar(30) NOT NULL DEFAULT 'unverified',
        ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS verification_source varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS verification_message varchar(1000) NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS finance_invoice_verifications (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        invoice_id int NOT NULL,
        status varchar(30) NOT NULL,
        source varchar(80) NOT NULL,
        checked_at timestamptz NOT NULL,
        message varchar(1000) NULL,
        request_snapshot jsonb NULL,
        response_snapshot jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_finance_invoice_verification_history ON finance_invoice_verifications (tenant_id, invoice_id, created_at)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS finance_tax_import_batches (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        original_name varchar(255) NOT NULL,
        status varchar(30) NOT NULL DEFAULT 'completed',
        total_rows int NOT NULL DEFAULT 0,
        imported_rows int NOT NULL DEFAULT 0,
        updated_rows int NOT NULL DEFAULT 0,
        skipped_rows int NOT NULL DEFAULT 0,
        failed_rows int NOT NULL DEFAULT 0,
        errors jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_finance_tax_import_batch_created ON finance_tax_import_batches (tenant_id, created_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS finance_tax_import_batches`);
    await queryRunner.query(`DROP TABLE IF EXISTS finance_invoice_verifications`);
    await queryRunner.query(`
      ALTER TABLE finance_invoices
        DROP COLUMN IF EXISTS tax_amount,
        DROP COLUMN IF EXISTS seller_tax_no,
        DROP COLUMN IF EXISTS buyer_tax_no,
        DROP COLUMN IF EXISTS recognition_status,
        DROP COLUMN IF EXISTS recognition_source,
        DROP COLUMN IF EXISTS recognition_confidence,
        DROP COLUMN IF EXISTS verification_status,
        DROP COLUMN IF EXISTS verified_at,
        DROP COLUMN IF EXISTS verification_source,
        DROP COLUMN IF EXISTS verification_message
    `);
  }
}
