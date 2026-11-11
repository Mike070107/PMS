import { MigrationInterface, QueryRunner } from 'typeorm';

export class PropertyArchiveHierarchy1795900000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE communities ADD COLUMN IF NOT EXISTS community_type varchar(20) NOT NULL DEFAULT 'community' CHECK (community_type IN ('community','apartment'))`);
    await q.query(`ALTER TABLE buildings ADD COLUMN IF NOT EXISTS building_type varchar(20) NOT NULL DEFAULT 'residential' CHECK (building_type IN ('residential','shop'))`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_building_id int REFERENCES buildings(id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_users_owner_building ON users(tenant_id, owner_building_id)`);
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_phones jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`UPDATE users SET contact_phones = jsonb_build_array(phone) WHERE phone IS NOT NULL AND phone <> '' AND contact_phones='[]'::jsonb`);
    await q.query(`CREATE TABLE IF NOT EXISTS owner_property_links (
      id serial PRIMARY KEY, tenant_id int NOT NULL, owner_id int NOT NULL REFERENCES users(id),
      house_id int REFERENCES houses(id), building_id int REFERENCES buildings(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((house_id IS NOT NULL)::int + (building_id IS NOT NULL)::int = 1)
    )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_property_house ON owner_property_links(tenant_id, owner_id, house_id) WHERE house_id IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_property_shop ON owner_property_links(tenant_id, owner_id, building_id) WHERE building_id IS NOT NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_owner_property_house ON owner_property_links(tenant_id,house_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS ix_owner_property_building ON owner_property_links(tenant_id,building_id)`);
    // Keep historical orphan references untouched in users; never invent a house or cross tenants.
    await q.query(`INSERT INTO owner_property_links(tenant_id,owner_id,house_id) SELECT u.tenant_id,u.id,u.house_id FROM users u JOIN houses h ON h.id=u.house_id AND h.tenant_id=u.tenant_id WHERE u.role='owner' AND u.tenant_id IS NOT NULL AND u.house_id IS NOT NULL ON CONFLICT DO NOTHING`);
    await q.query(`CREATE TABLE IF NOT EXISTS owner_phone_activity (
      tenant_id int NOT NULL, owner_id int NOT NULL REFERENCES users(id), phone varchar(30) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'unknown', last_used_at timestamptz,
      last_contacted_at timestamptz, last_attempted_at timestamptz, last_result varchar(20),
      updated_by int, PRIMARY KEY(tenant_id,owner_id,phone)
    )`);
    await q.query(`CREATE TABLE IF NOT EXISTS owner_phone_events (
      id serial PRIMARY KEY, tenant_id int NOT NULL, owner_id int NOT NULL REFERENCES users(id),
      phone varchar(30) NOT NULL, result varchar(20) NOT NULL, note varchar(255),
      occurred_at timestamptz NOT NULL DEFAULT now(), operator_id int
    )`);
    // Do not infer business classifications from names or rewrite existing owner links.
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE owner_phone_events');
    await q.query('DROP TABLE owner_phone_activity');
    await q.query('DROP TABLE owner_property_links');
    await q.query('ALTER TABLE users DROP COLUMN contact_phones');
    await q.query('DROP INDEX ix_users_owner_building');
    await q.query('ALTER TABLE users DROP COLUMN owner_building_id');
    await q.query('ALTER TABLE buildings DROP COLUMN building_type');
    await q.query('ALTER TABLE communities DROP COLUMN community_type');
  }
}
