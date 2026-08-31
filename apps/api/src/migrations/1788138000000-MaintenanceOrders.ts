import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 养护单（《房屋修理养护任务单》）+ 预算定额条目（2026-08-31）。
 *
 * 只新增对象、全部 IF NOT EXISTS —— 开发库 synchronize 已建好时安全跳过。
 *
 * 最后一段是给存量租户开通新页面：tenants.enabled_pages 是「这家公司买了哪些
 * 后台功能」，新 key 不塞进去的话，上线当天所有人都找不到「养护单」在哪
 * （2026-08-26 的「系统设置」就这么丢过一次）。
 */
export class MaintenanceOrders1788138000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS quota_items (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        code varchar(40) NOT NULL,
        name varchar(120) NOT NULL,
        unit varchar(20) NOT NULL DEFAULT '项',
        hours numeric(10,3) NOT NULL DEFAULT 0,
        material_fee_cents int NOT NULL DEFAULT 0,
        remark varchar(255),
        enabled boolean NOT NULL DEFAULT true,
        sort_order int NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_quota_items_tenant ON quota_items (tenant_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_items_code ON quota_items (tenant_id, code)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS maintenance_orders (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        tenant_id int NOT NULL,
        order_no varchar(40) NOT NULL,
        paper_no varchar(40),
        work_order_id int NOT NULL,
        work_order_no varchar(40),
        request_id int,
        community_id int NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'draft',
        unit_name varchar(120),
        reporter_name varchar(60),
        addr_village varchar(60),
        addr_road varchar(60),
        addr_lane varchar(30),
        addr_building_no varchar(30),
        addr_room varchar(30),
        reported_on date,
        present_time varchar(60),
        fault_part varchar(120),
        repair_item varchar(120),
        appoint_on date,
        start_on date,
        finish_on date,
        part_category varchar(20),
        fee_category varchar(20),
        share_method varchar(20),
        repair_date_text varchar(60),
        fee_category_text varchar(60),
        share_method_text varchar(60),
        items jsonb NOT NULL DEFAULT '[]',
        materials jsonb NOT NULL DEFAULT '[]',
        labor_rate_cents int NOT NULL DEFAULT 0,
        coefficient numeric(8,4) NOT NULL DEFAULT 1,
        total_cents int NOT NULL DEFAULT 0,
        material_total_cents int NOT NULL DEFAULT 0,
        scrap_note text,
        voucher_issue varchar(120),
        filler_id int,
        filler_name varchar(60),
        filler_sign_url varchar(500),
        repairer_id int,
        repairer_name varchar(60),
        repairer_sign_url varchar(500),
        inspector_id int,
        inspector_name varchar(60),
        inspector_sign_url varchar(500),
        inspected_at timestamptz,
        owner_sign_url varchar(500),
        service_record varchar(120),
        follow_up_record varchar(120)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_maintenance_orders_status ON maintenance_orders (tenant_id, status)`,
    );
    // 一张工单同时只能有一张有效养护单；作废的不占位，可以重新开
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_orders_work_order
         ON maintenance_orders (tenant_id, work_order_id) WHERE status <> 'void'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_orders_no ON maintenance_orders (order_no)`,
    );

    // 存量租户开通「养护单」「养护单查验」两页
    await queryRunner.query(`
      UPDATE tenants
         SET enabled_pages = enabled_pages || '["maintenance-orders","maintenance-inspect"]'::jsonb
       WHERE enabled_pages IS NOT NULL
         AND NOT (enabled_pages @> '["maintenance-orders"]'::jsonb)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS maintenance_orders`);
    await queryRunner.query(`DROP TABLE IF EXISTS quota_items`);
  }
}
