import { MigrationInterface, QueryRunner } from 'typeorm';

/** 车牌办理单（新办车牌 / 亲情车扫码自填）。生产 DB_SYNCHRONIZE 会自动建表，这里给开发库兜底。 */
export class VehicleIntakes1792700000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS vehicle_intakes (
      id SERIAL PRIMARY KEY,
      tenant_id int NOT NULL,
      kind varchar(10) NOT NULL,
      status varchar(12) NOT NULL DEFAULT 'waiting',
      house_id int NOT NULL,
      community_id int NULL,
      house_label varchar(120) NOT NULL DEFAULT '',
      owner_name varchar(50) NOT NULL DEFAULT '',
      owner_phone varchar(30) NOT NULL DEFAULT '',
      plate varchar(10) NOT NULL DEFAULT '',
      contact_name varchar(50) NOT NULL DEFAULT '',
      contact_phone varchar(30) NOT NULL DEFAULT '',
      vehicle_class varchar(12) NOT NULL DEFAULT '',
      relation varchar(20) NOT NULL DEFAULT '',
      files jsonb NOT NULL DEFAULT '[]'::jsonb,
      garages jsonb NOT NULL DEFAULT '[]'::jsonb,
      garage_numbers jsonb NOT NULL DEFAULT '{}'::jsonb,
      token_hash varchar(64) NOT NULL,
      token_nonce varchar(32) NOT NULL DEFAULT '',
      expires_at timestamptz NOT NULL,
      opened_at timestamptz NULL,
      submitted_at timestamptz NULL,
      reviewed_by int NULL,
      reviewed_at timestamptz NULL,
      review_note varchar(500) NOT NULL DEFAULT '',
      transaction_id int NULL,
      family_car_id int NULL,
      log jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by int NULL,
      updated_by int NULL
    )`);
    await q.query(`ALTER TABLE vehicle_intakes ADD COLUMN IF NOT EXISTS token_nonce varchar(32) NOT NULL DEFAULT ''`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_intakes_status ON vehicle_intakes (tenant_id, status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_intakes_house ON vehicle_intakes (tenant_id, house_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_intakes_token ON vehicle_intakes (token_hash)`);
    await q.query(`CREATE TABLE IF NOT EXISTS parking_plate_tags (
      id SERIAL PRIMARY KEY, tenant_id int NOT NULL, plate varchar(10) NOT NULL, vehicle_class varchar(12) NOT NULL, house_id int NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by int NULL, updated_by int NULL
    )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_plate_tags ON parking_plate_tags (tenant_id, plate)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS parking_plate_tags`);
    await q.query(`DROP TABLE IF EXISTS vehicle_intakes`);
  }
}
