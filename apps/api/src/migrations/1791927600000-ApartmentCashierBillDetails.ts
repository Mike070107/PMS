import { MigrationInterface, QueryRunner } from 'typeorm';

export class ApartmentCashierBillDetails1791927600000 implements MigrationInterface {
  name = 'ApartmentCashierBillDetails1791927600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "quantity" numeric(12,3)`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "unit" varchar(12)`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "unit_price_cents" integer`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "service_from" date`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "service_to" date`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "vehicle_plate" varchar(30)`);
    await queryRunner.query(`ALTER TABLE "fee_bills" ADD COLUMN "legacy_payload" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "legacy_payload"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "vehicle_plate"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "service_to"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "service_from"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "unit_price_cents"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "unit"`);
    await queryRunner.query(`ALTER TABLE "fee_bills" DROP COLUMN "quantity"`);
  }
}
