import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MIS 镜像第一阶段：基础维度 + 账单镜像 + 同步水位。
 *
 * 原则：不照搬 MIS 全部列，只存读取报表所需的稳定字段；ZJ_ID 为幂等主键。
 * 全量重灌由手工任务执行，本迁移只建表，不触发同步。
 */
export class MisMirror1794500000000 implements MigrationInterface {
  name = 'MisMirror1794500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_offices (
        office_code varchar(16) PRIMARY KEY,
        office_name varchar(60),
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_building (
        l_id bigint PRIMARY KEY,
        office_code varchar(16) NOT NULL,
        road varchar(60),
        lane varchar(30),
        building_no varchar(30),
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_room (
        s_id bigint PRIMARY KEY,
        l_id bigint,
        room_no varchar(30) NOT NULL,
        nature varchar(20),
        area_sqm numeric(10,2),
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_owner (
        zh_id bigint PRIMARY KEY,
        s_id bigint,
        name varchar(60),
        mobile varchar(30),
        phone2 varchar(30),
        source_updated_at timestamptz,
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_fee_item (
        fee_code varchar(20) PRIMARY KEY,
        fee_name varchar(100) NOT NULL,
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_payment_method (
        method_id int PRIMARY KEY,
        method_name varchar(50) NOT NULL,
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_mirror_bill (
        zj_id bigint PRIMARY KEY,
        office_code varchar(16) NOT NULL,
        l_id bigint,
        s_id bigint,
        zh_id bigint,
        owner_name varchar(60),
        room_no varchar(30),
        address varchar(255),
        fee_code varchar(20),
        fee_name varchar(100),
        period varchar(6),
        amount_cents bigint NOT NULL,
        paid_date date,
        refund_date date,
        payment_method varchar(30),
        cashier varchar(60),
        source_updated_at timestamptz,
        synced_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_bill_office_house ON mis_mirror_bill(office_code, s_id)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_bill_paid_date ON mis_mirror_bill(paid_date)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_bill_refund_date ON mis_mirror_bill(refund_date)');
    await q.query('CREATE INDEX IF NOT EXISTS idx_mis_mirror_bill_source_updated ON mis_mirror_bill(source_updated_at, zj_id)');
    await q.query(`
      CREATE TABLE IF NOT EXISTS mis_sync_state (
        tenant_id int NOT NULL,
        source_table varchar(40) NOT NULL,
        last_updated_at timestamptz,
        last_id bigint,
        last_success_at timestamptz,
        last_attempt_at timestamptz,
        last_error varchar(500),
        lag_rows bigint NOT NULL DEFAULT 0,
        synced_rows bigint NOT NULL DEFAULT 0,
        initialized_at timestamptz,
        PRIMARY KEY (tenant_id, source_table)
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'mis_sync_state',
      'mis_mirror_bill',
      'mis_mirror_payment_method',
      'mis_mirror_fee_item',
      'mis_mirror_owner',
      'mis_mirror_room',
      'mis_mirror_building',
      'mis_mirror_offices',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}
