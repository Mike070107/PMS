import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 抄表模块首版：仪表档案、抄表记录、应收账单。
 *
 * 三张表都是新增，不改任何存量表；生产可以先跑迁移再发 API。
 * 金额一律整数分，读数/用量 numeric(14,3) 存字符串，避免 JS 浮点误差。
 */
export class Meters1792900000000 implements MigrationInterface {
  name = 'Meters1792900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS meters (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        meter_no varchar(64) NOT NULL,
        meter_type varchar(20) NOT NULL,
        name varchar(120),
        spec varchar(120),
        manufacturer varchar(120),
        model varchar(120),
        multiplier numeric(10,3) NOT NULL DEFAULT 1,
        integer_digits int NOT NULL DEFAULT 6,
        decimal_digits int NOT NULL DEFAULT 0,
        unit varchar(20) NOT NULL DEFAULT 'm³',
        community_id int,
        house_id int,
        install_address varchar(255),
        latitude numeric(10,7),
        longitude numeric(10,7),
        owner_name varchar(60),
        owner_phone varchar(30),
        unit_price_cents int NOT NULL DEFAULT 0,
        billing_enabled boolean NOT NULL DEFAULT true,
        initial_reading numeric(14,3),
        initial_reading_at timestamptz,
        last_reading_value numeric(14,3),
        last_reading_at timestamptz,
        status varchar(20) NOT NULL DEFAULT 'active',
        qr_token varchar(64) NOT NULL,
        photo_key varchar(255),
        photo_url varchar(500),
        sort_order int NOT NULL DEFAULT 0,
        remark text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        CONSTRAINT fk_meters_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL,
        CONSTRAINT fk_meters_house FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meters_tenant_type ON meters(tenant_id, meter_type)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meters_tenant_community ON meters(tenant_id, community_id)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meters_tenant_no ON meters(tenant_id, meter_type, meter_no)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meters_qr_token ON meters(qr_token)`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS meter_readings (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        meter_id int NOT NULL,
        meter_no_snapshot varchar(64) NOT NULL,
        reading_value numeric(14,3) NOT NULL,
        previous_value numeric(14,3),
        usage_value numeric(14,3),
        read_at timestamptz NOT NULL,
        source varchar(20) NOT NULL DEFAULT 'photo',
        photo_key varchar(255),
        photo_url varchar(500),
        photo_width int,
        photo_height int,
        roi jsonb,
        ocr_status varchar(20) NOT NULL DEFAULT 'skipped',
        ocr_provider varchar(20),
        ocr_confidence numeric(5,2),
        ocr_text text,
        ocr_meter_no varchar(64),
        ocr_raw jsonb,
        status varchar(20) NOT NULL DEFAULT 'confirmed',
        anomaly_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
        latitude numeric(10,7),
        longitude numeric(10,7),
        gps_accuracy numeric(8,2),
        operator_id int,
        operator_name varchar(60),
        client_request_id varchar(64),
        note text,
        reviewed_by int,
        reviewed_at timestamptz,
        review_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        CONSTRAINT fk_meter_readings_meter FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE RESTRICT
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_readings_meter_time ON meter_readings(tenant_id, meter_id, read_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_readings_tenant_time ON meter_readings(tenant_id, read_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_readings_status ON meter_readings(tenant_id, status)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meter_readings_client ON meter_readings(tenant_id, client_request_id) WHERE client_request_id IS NOT NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS meter_charges (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        meter_id int NOT NULL,
        reading_id int NOT NULL,
        meter_no_snapshot varchar(64) NOT NULL,
        owner_name_snapshot varchar(60),
        period varchar(7) NOT NULL,
        usage_value numeric(14,3) NOT NULL,
        unit_price_cents int NOT NULL,
        amount_cents int NOT NULL,
        adjustment_cents int NOT NULL DEFAULT 0,
        receivable_cents int NOT NULL,
        paid_cents int NOT NULL DEFAULT 0,
        status varchar(20) NOT NULL DEFAULT 'unpaid',
        due_date date,
        paid_at timestamptz,
        payment_method varchar(30),
        receipt_no varchar(60),
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int,
        CONSTRAINT fk_meter_charges_meter FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE RESTRICT,
        CONSTRAINT fk_meter_charges_reading FOREIGN KEY (reading_id) REFERENCES meter_readings(id) ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_charges_meter_period ON meter_charges(tenant_id, meter_id, period)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_charges_tenant_status ON meter_charges(tenant_id, status)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meter_charges_reading ON meter_charges(reading_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS meter_charges`);
    await q.query(`DROP TABLE IF EXISTS meter_readings`);
    await q.query(`DROP TABLE IF EXISTS meters`);
  }
}
