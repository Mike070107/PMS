import { MigrationInterface, QueryRunner } from 'typeorm';

/** 每次实收独立留痕；账单行锁和请求编号共同防止部分收款重试重复累计。 */
export class MeterChargePayments1792900000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE meter_charge_payments (
      id serial PRIMARY KEY, tenant_id int NOT NULL,
      charge_id int NOT NULL REFERENCES meter_charges(id),
      amount_cents int NOT NULL CHECK (amount_cents > 0), method varchar(30) NOT NULL,
      paid_at timestamptz NOT NULL, receipt_no varchar(60), note text, operator_id int NOT NULL,
      client_request_id varchar(80), request_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, charge_id, client_request_id)
    )`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE meter_charge_payments');
  }
}
