import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommercialAccessCard1797210000000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query('ALTER TABLE access_cards ADD COLUMN shop_building_id integer REFERENCES buildings(id)');
    await db.query('ALTER TABLE access_cards ALTER COLUMN house_id DROP NOT NULL');
    await db.query(`ALTER TABLE access_cards ADD CONSTRAINT ck_access_card_property
      CHECK ((house_id IS NULL) <> (shop_building_id IS NULL))`);
    await db.query('CREATE INDEX idx_access_cards_shop ON access_cards(tenant_id, shop_building_id) WHERE shop_building_id IS NOT NULL');
  }

  async down(): Promise<void> {
    throw new Error('Retain commercial access card bindings when rolling back application code');
  }
}
