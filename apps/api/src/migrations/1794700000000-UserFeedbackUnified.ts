import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 统一「意见与建议 / 异常反馈」：在已有 user_feedback 上扩展 kind/attachments/context/source。
 * - kind: suggestion（意见）| error（异常）
 * - attachments: [{url,name,size,mime}] 最多 5 个、每个 ≤20MB（大小由服务端对象存储实测）
 * - context: {page,userAgent,recentErrors[],appVersion}
 * - source: web | miniapp-staff | miniapp-owner
 * 老字段 image_urls/video_url 保留不动，旧版小程序仍可提交；新客户端写 attachments。
 */
export class UserFeedbackUnified1794700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'suggestion'`);
    await queryRunner.query(`ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS context jsonb NULL`);
    await queryRunner.query(`ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'miniapp-staff'`);
    // 老数据全部是员工端「意见与建议」，上面的默认值即完成回填。
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_feedback_kind') THEN
          ALTER TABLE user_feedback ADD CONSTRAINT chk_user_feedback_kind CHECK (kind IN ('suggestion','error'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_feedback_source') THEN
          ALTER TABLE user_feedback ADD CONSTRAINT chk_user_feedback_source CHECK (source IN ('web','miniapp-staff','miniapp-owner'));
        END IF;
      END $$;
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_feedback_tenant_kind_created ON user_feedback (tenant_id, kind, created_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_feedback_tenant_status_created ON user_feedback (tenant_id, status, created_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_feedback_tenant_status_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_feedback_tenant_kind_created`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP CONSTRAINT IF EXISTS chk_user_feedback_source`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP CONSTRAINT IF EXISTS chk_user_feedback_kind`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP COLUMN IF EXISTS source`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP COLUMN IF EXISTS context`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP COLUMN IF EXISTS attachments`);
    await queryRunner.query(`ALTER TABLE user_feedback DROP COLUMN IF EXISTS kind`);
  }
}
