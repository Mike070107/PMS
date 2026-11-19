import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReceiptPrint1796700000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`
      CREATE TABLE receipt_printers (
        id serial PRIMARY KEY, tenant_id int NOT NULL, name varchar(60) NOT NULL,
        pairing_hash text UNIQUE, expires_at timestamptz, token_hash text UNIQUE,
        queue_name varchar(160), seen_at timestamptz, created_by int NOT NULL, UNIQUE(tenant_id,name)
      );
      CREATE TABLE receipt_print_grants (
        printer_id int REFERENCES receipt_printers ON DELETE CASCADE, employee_id int REFERENCES users,
        PRIMARY KEY(printer_id,employee_id)
      );
      CREATE TABLE receipt_print_jobs (
        id serial PRIMARY KEY, printer_id int NOT NULL REFERENCES receipt_printers,
        tenant_id int NOT NULL, employee_id int NOT NULL, receipt_no text NOT NULL,
        request_id text NOT NULL, reprint boolean NOT NULL, lines jsonb NOT NULL,
        state text NOT NULL DEFAULT 'waiting', created_at timestamptz NOT NULL DEFAULT now(),
        claimed_at timestamptz, UNIQUE(tenant_id,employee_id,request_id)
      );
      CREATE UNIQUE INDEX receipt_print_original ON receipt_print_jobs(tenant_id,receipt_no) WHERE NOT reprint;
      CREATE INDEX receipt_print_pending ON receipt_print_jobs(printer_id,state,created_at);
      CREATE INDEX receipt_print_by_receipt ON receipt_print_jobs(tenant_id,receipt_no,created_at DESC)
    `);
  }
  async down(q: QueryRunner) {
    await q.query(
      'DROP TABLE receipt_print_jobs, receipt_print_grants, receipt_printers',
    );
  }
}
