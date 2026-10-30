import { MigrationInterface, QueryRunner } from 'typeorm';

/** 识别学习：记录自动旋转角，并保存人工纠错样本（原图+ROI+预测值/纠正值）。 */
export class MeterLearning1792900000001 implements MigrationInterface {
  name = 'MeterLearning1792900000001';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS meter_readings ADD COLUMN IF NOT EXISTS orientation int NOT NULL DEFAULT 0`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS meter_ocr_samples (
        id serial PRIMARY KEY,
        tenant_id int NOT NULL,
        meter_id int NOT NULL,
        reading_id int,
        meter_no_snapshot varchar(64) NOT NULL,
        meter_type varchar(20) NOT NULL,
        integer_digits int NOT NULL DEFAULT 0,
        decimal_digits int NOT NULL DEFAULT 0,
        photo_key varchar(255),
        photo_url varchar(500),
        roi jsonb,
        orientation int NOT NULL DEFAULT 0,
        ocr_provider varchar(20),
        ocr_text text,
        confidence numeric(5,2),
        predicted_value numeric(14,3),
        predicted_digits varchar(32),
        corrected_value numeric(14,3),
        corrected_digits varchar(32),
        status varchar(20) NOT NULL DEFAULT 'candidate',
        source varchar(20) NOT NULL DEFAULT 'review',
        note text,
        corrected_by int,
        corrected_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int,
        updated_by int
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_ocr_samples_tenant_status ON meter_ocr_samples(tenant_id, status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_meter_ocr_samples_meter ON meter_ocr_samples(tenant_id, meter_id)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meter_ocr_samples_reading ON meter_ocr_samples(reading_id) WHERE reading_id IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS meter_ocr_samples`);
    await q.query(`ALTER TABLE IF EXISTS meter_readings DROP COLUMN IF EXISTS orientation`);
  }
}
