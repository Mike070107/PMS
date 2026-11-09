import { MigrationInterface, QueryRunner } from 'typeorm';

/** 库存流水记录库位：入库/出库/冲销时带上库位，支持按货架聚合与批次流水展示。 */
export class StockMovementLocation1795200000000 implements MigrationInterface {
  name = 'StockMovementLocation1795200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_id int');
    await q.query('CREATE INDEX IF NOT EXISTS ix_stock_movements_location ON stock_movements(tenant_id, location_id)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS ix_stock_movements_location');
    await q.query('ALTER TABLE stock_movements DROP COLUMN IF EXISTS location_id');
  }
}
