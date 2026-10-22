import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 亲情车管理：登记表 + 扫码上传会话关联字段。
 * 生产库由 synchronize 建表；本迁移供开发/测试库使用，全部 IF NOT EXISTS。
 */
export class FamilyCars1792400000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS family_cars (
      id serial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by integer NULL,
      updated_by integer NULL,
      tenant_id integer NOT NULL,
      house_id integer NULL,
      lane varchar(10) NOT NULL,
      building_no varchar(10) NOT NULL,
      room_no varchar(20) NOT NULL,
      owner_name varchar(50) NOT NULL DEFAULT '',
      owner_phone varchar(30) NOT NULL DEFAULT '',
      owner_user_id integer NULL,
      car_owner_name varchar(50) NOT NULL DEFAULT '',
      car_owner_phone varchar(30) NOT NULL DEFAULT '',
      relation varchar(20) NOT NULL DEFAULT '',
      plate varchar(20) NOT NULL,
      remark varchar(200) NOT NULL DEFAULT '',
      database varchar(20) NOT NULL,
      garages jsonb NOT NULL DEFAULT '[]'::jsonb,
      garage_numbers jsonb NOT NULL DEFAULT '{}'::jsonb,
      mode varchar(20) NOT NULL DEFAULT 'new',
      status varchar(20) NOT NULL DEFAULT 'upload',
      owner_fill boolean NOT NULL DEFAULT false,
      files jsonb NOT NULL DEFAULT '[]'::jsonb,
      proof_upload_id integer NULL,
      registration_operation_id integer NULL,
      open_operation_id integer NULL,
      renew_operation_id integer NULL,
      expire_operation_id integer NULL,
      civil_operation_id integer NULL,
      office_reviewed_by integer NULL,
      office_reviewed_at timestamptz NULL,
      office_note varchar(500) NOT NULL DEFAULT '',
      manager_reviewed_by integer NULL,
      manager_reviewed_at timestamptz NULL,
      manager_note varchar(500) NOT NULL DEFAULT '',
      start_date date NULL,
      end_date date NULL,
      reminded_at timestamptz NULL,
      previous_id integer NULL,
      last_error varchar(500) NULL,
      log jsonb NOT NULL DEFAULT '[]'::jsonb
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_family_cars_status ON family_cars(tenant_id, status)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_family_cars_plate ON family_cars(tenant_id, plate)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_family_cars_house ON family_cars(tenant_id, house_id)`);
    await q.query(`ALTER TABLE parking_proof_uploads
      ADD COLUMN IF NOT EXISTS family_car_id integer NULL,
      ADD COLUMN IF NOT EXISTS form jsonb NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE parking_proof_uploads DROP COLUMN IF EXISTS form, DROP COLUMN IF EXISTS family_car_id');
    await q.query('DROP TABLE IF EXISTS family_cars');
  }
}
