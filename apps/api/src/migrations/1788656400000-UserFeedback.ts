import { MigrationInterface, QueryRunner } from 'typeorm';

/** 员工小程序意见与建议：文字 + 4 图 + 1 个不超过 15 秒的视频。 */
export class UserFeedback1788656400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_feedback (
        id SERIAL PRIMARY KEY,
        tenant_id int NOT NULL,
        user_id int NOT NULL,
        user_name varchar(60) NULL,
        user_phone varchar(30) NULL,
        content text NOT NULL,
        image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        video_url varchar(1024) NULL,
        video_duration_seconds smallint NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL,
        CONSTRAINT chk_user_feedback_video_duration
          CHECK (video_duration_seconds IS NULL OR video_duration_seconds BETWEEN 1 AND 15)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_feedback_tenant_created ON user_feedback (tenant_id, created_at)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_feedback_tenant_user ON user_feedback (tenant_id, user_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_feedback`);
  }
}
