import { MigrationInterface, QueryRunner } from 'typeorm';

export class Stocktake1788404400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stocktake_tasks (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        task_no varchar(40) NOT NULL,
        title varchar(120) NOT NULL,
        warehouse_id int NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'counting',
        total_count int NOT NULL DEFAULT 0,
        counted_count int NOT NULL DEFAULT 0,
        difference_count int NOT NULL DEFAULT 0,
        snapshot_at timestamptz NOT NULL,
        submitted_at timestamptz NULL,
        reviewed_at timestamptz NULL,
        reviewer_id int NULL,
        review_note varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL,
        CONSTRAINT uq_stocktake_task_no UNIQUE (tenant_id, task_no)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_stocktake_task_warehouse_status ON stocktake_tasks (tenant_id, warehouse_id, status)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stocktake_items (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        task_id int NOT NULL,
        material_id int NOT NULL,
        location_id int NULL,
        location_label varchar(200) NULL,
        book_qty numeric(12,2) NOT NULL,
        actual_qty numeric(12,2) NULL,
        difference_qty numeric(12,2) NULL,
        reason_code varchar(40) NULL,
        note varchar(500) NULL,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        counted_by int NULL,
        counted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL,
        CONSTRAINT uq_stocktake_task_material UNIQUE (tenant_id, task_id, material_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_stocktake_item_progress ON stocktake_items (tenant_id, task_id, counted_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS stocktake_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS stocktake_tasks`);
  }
}
