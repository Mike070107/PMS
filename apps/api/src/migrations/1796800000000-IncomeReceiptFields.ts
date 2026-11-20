import { MigrationInterface, QueryRunner } from 'typeorm';

export class IncomeReceiptFields1796800000000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query('ALTER TABLE mis_mirror_bill ADD COLUMN receipt_remark text, ADD COLUMN receipt_paid_at varchar(19)');
  }
  async down(db: QueryRunner) {
    await db.query('ALTER TABLE mis_mirror_bill DROP COLUMN receipt_remark, DROP COLUMN receipt_paid_at');
  }
}
