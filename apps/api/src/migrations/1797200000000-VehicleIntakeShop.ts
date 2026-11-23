import { MigrationInterface, QueryRunner } from 'typeorm';

export class VehicleIntakeShop1797200000000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query('ALTER TABLE buildings ADD COLUMN IF NOT EXISTS shop_name varchar(60)');
    await db.query('ALTER TABLE vehicle_intakes ADD COLUMN IF NOT EXISTS shop_building_id integer REFERENCES buildings(id)');
    await db.query('ALTER TABLE vehicle_intakes ALTER COLUMN house_id DROP NOT NULL');
    await db.query('ALTER TABLE vehicle_intake_operations ALTER COLUMN house_id DROP NOT NULL');
    await db.query('ALTER TABLE expired_vehicle_intake_operations ALTER COLUMN house_id DROP NOT NULL');
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vehicle_intake_property' AND conrelid = 'vehicle_intakes'::regclass)
      THEN ALTER TABLE vehicle_intakes ADD CONSTRAINT ck_vehicle_intake_property
        CHECK ((house_id IS NOT NULL AND shop_building_id IS NULL)
          OR (house_id IS NULL AND shop_building_id IS NOT NULL AND kind = 'paid')); END IF;
    END $$`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_vehicle_intake_shop ON vehicle_intakes(tenant_id, shop_building_id) WHERE shop_building_id IS NOT NULL');
  }

  async down(): Promise<void> {
    throw new Error('Retain commercial vehicle registrations when rolling back application code');
  }
}
