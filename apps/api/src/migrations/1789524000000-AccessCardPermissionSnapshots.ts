import { MigrationInterface, QueryRunner } from 'typeorm';

/** 给既有发卡历史补充 MjSystem/iCCard 实际权限表的只读核验结果。 */
export class AccessCardPermissionSnapshots1789524000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE access_card_legacy_snapshots
        ADD COLUMN IF NOT EXISTS permission_status varchar(20) NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS permission_subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS permission_requested_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS permission_refreshed_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS permission_lease_agent_key varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS permission_lease_expires_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS permission_last_error varchar(500) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_access_card_permission_claim
        ON access_card_legacy_snapshots (tenant_id, permission_status, permission_requested_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_access_card_permission_claim');
    await queryRunner.query(`
      ALTER TABLE access_card_legacy_snapshots
        DROP COLUMN IF EXISTS permission_last_error,
        DROP COLUMN IF EXISTS permission_lease_expires_at,
        DROP COLUMN IF EXISTS permission_lease_agent_key,
        DROP COLUMN IF EXISTS permission_refreshed_at,
        DROP COLUMN IF EXISTS permission_requested_at,
        DROP COLUMN IF EXISTS permissions,
        DROP COLUMN IF EXISTS permission_subjects,
        DROP COLUMN IF EXISTS permission_status
    `);
  }
}
