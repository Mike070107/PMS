import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkOrderMaterialReservations1795801000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS work_order_material_drafts (
      id serial PRIMARY KEY, tenant_id int NOT NULL, work_order_id int NOT NULL,
      rows jsonb NOT NULL DEFAULT '[]'::jsonb, version int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      created_by int, updated_by int, UNIQUE (tenant_id, work_order_id))`);
    await q.query(`CREATE TABLE IF NOT EXISTS stock_reservations (
      id serial PRIMARY KEY, tenant_id int NOT NULL, work_order_id int NOT NULL,
      warehouse_id int NOT NULL, material_id int NOT NULL, qty numeric(12,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      created_by int, updated_by int,
      UNIQUE (tenant_id, work_order_id, warehouse_id, material_id))`);
    await q.query('CREATE INDEX IF NOT EXISTS ix_stock_reservations_stock ON stock_reservations (tenant_id, warehouse_id, material_id)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS stock_reservations');
    await q.query('DROP TABLE IF EXISTS work_order_material_drafts');
  }
}
