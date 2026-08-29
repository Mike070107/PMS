import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 库位打通到全流程（2026-08-30）。
 *
 * 库位表 `warehouse_locations` 早就有了，但只能在仓库档案里增删改：
 * 库存清单不显示库位、调拨入库不能选库位、每次入库都要从头挑一遍。
 * 补两列把它接进流程：
 *
 * · warehouses.default_location_id —— 该仓的默认入库库位，入库表单带出来，可改
 * · stocks.location_id            —— 这份库存现在放在哪，最近一次入库写入，清单直接显示
 *
 * 都是可空：没配库位的仓照旧工作，不强制。
 */
export class WarehouseLocationsInFlow1788048000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS default_location_id int`,
    );
    await queryRunner.query(
      `ALTER TABLE stocks ADD COLUMN IF NOT EXISTS location_id int`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN warehouses.default_location_id IS '默认入库库位；入库/调拨入库带出这个值，可改'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN stocks.location_id IS '当前存放库位，最近一次入库写入；空 = 没配库位'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stocks DROP COLUMN IF EXISTS location_id`);
    await queryRunner.query(
      `ALTER TABLE warehouses DROP COLUMN IF EXISTS default_location_id`,
    );
  }
}
