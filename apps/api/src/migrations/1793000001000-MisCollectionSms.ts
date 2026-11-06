import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 住宅催缴短信逐条发送记录与回执。
 * 生产由 synchronize 建表；本迁移供开发/测试库使用，全部 IF NOT EXISTS。
 */
export class MisCollectionSms1793000001000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS mis_collection_sms (
      id serial PRIMARY KEY,
      tenant_id int NOT NULL,
      batch_id int NOT NULL,
      house_key varchar(64) NOT NULL,
      phone_tail varchar(8) NOT NULL,
      content text NOT NULL,
      status varchar(12) NOT NULL DEFAULT 'queued',
      biz_id varchar(80),
      error varchar(200),
      segment_count int NOT NULL DEFAULT 1,
      submitted_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by int,
      updated_by int
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mis_sms_batch ON mis_collection_sms(tenant_id, batch_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mis_sms_biz ON mis_collection_sms(tenant_id, biz_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS mis_collection_sms');
  }
}
