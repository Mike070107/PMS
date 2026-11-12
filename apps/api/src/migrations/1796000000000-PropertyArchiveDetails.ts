import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive only: unknown archive details remain NULL; never infer or rewrite MIS/history. */
export class PropertyArchiveDetails1796000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE houses ADD COLUMN IF NOT EXISTS floor varchar(30), ADD COLUMN IF NOT EXISTS property_nature varchar(60), ADD COLUMN IF NOT EXISTS room_layout varchar(60), ADD COLUMN IF NOT EXISTS remark varchar(500)`);
    await q.query(`ALTER TABLE owner_property_links ADD COLUMN IF NOT EXISTS move_in_date date, ADD COLUMN IF NOT EXISTS billing_start_date date`);
    await q.query(`ALTER TABLE owner_phone_activity ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS confirmation_source varchar(20)`);
    await q.query(`ALTER TABLE owner_phone_events ADD COLUMN IF NOT EXISTS confirmation_source varchar(20)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE owner_phone_events DROP COLUMN confirmation_source`);
    await q.query(`ALTER TABLE owner_phone_activity DROP COLUMN confirmation_source, DROP COLUMN last_confirmed_at`);
    await q.query(`ALTER TABLE owner_property_links DROP COLUMN billing_start_date, DROP COLUMN move_in_date`);
    await q.query(`ALTER TABLE houses DROP COLUMN remark, DROP COLUMN room_layout, DROP COLUMN property_nature, DROP COLUMN floor`);
  }
}
