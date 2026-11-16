import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExperienceDocumentSharing1789138800000 implements MigrationInterface {
  name = 'ExperienceDocumentSharing1789138800000';
  async up(q: QueryRunner): Promise<void> {
    // Existing notes keep their original office/type ACL; never silently publish or privatize them.
    await q.query(`ALTER TABLE repair_experience_notes
      ADD COLUMN IF NOT EXISTS visibility varchar(20) NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS community_ids jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS repair_types jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS allow_edit boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS allow_delete boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
    await q.query(`ALTER TABLE repair_experience_notes ALTER COLUMN visibility SET DEFAULT 'private'`);
    await q.query(`UPDATE repair_experience_notes n SET search_text = COALESCE((
      SELECT string_agg(concat_ws(' ', b->>'text', b->>'caption',
        regexp_replace(COALESCE(b->>'html', ''), '<[^>]*>', ' ', 'g')), ' ')
      FROM jsonb_array_elements(n.blocks) b
    ), '') WHERE search_text = ''`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_experience_owner_live ON repair_experience_notes (tenant_id, created_by, updated_at DESC) WHERE deleted_at IS NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_experience_communities ON repair_experience_notes USING gin (community_ids) WHERE deleted_at IS NULL AND visibility = 'published'`);
  }
  async down(q: QueryRunner): Promise<void> {
    // An old application would treat new private documents as old shared notebook entries.
    // Refuse unsafe rollback; operators must explicitly archive/export new documents first.
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM repair_experience_notes WHERE visibility <> 'legacy') THEN
      RAISE EXCEPTION 'Refusing rollback: private/published experience documents would lose their ACL'; END IF; END $$`);
    await q.query('DROP INDEX IF EXISTS idx_experience_communities');
    await q.query('DROP INDEX IF EXISTS idx_experience_owner_live');
    await q.query(`ALTER TABLE repair_experience_notes DROP COLUMN IF EXISTS deleted_at,
      DROP COLUMN IF EXISTS search_text, DROP COLUMN IF EXISTS allow_delete,
      DROP COLUMN IF EXISTS allow_edit, DROP COLUMN IF EXISTS repair_types,
      DROP COLUMN IF EXISTS community_ids, DROP COLUMN IF EXISTS visibility`);
  }
}
