import { MigrationInterface, QueryRunner } from 'typeorm';

/** 浏览器绑定、同人确认与 OIDC 应用级授权。 */
export class HardenQrAccessGate1789686400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS scanned_by_user_id integer NULL`);
    await queryRunner.query(`ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS browser_secret_hash char(64) NULL`);
    await queryRunner.query(`ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS confirmation_code char(4) NULL`);
    await queryRunner.query(`ALTER TABLE oidc_authorization_codes ADD COLUMN IF NOT EXISTS required_app_id integer NULL`);
    await queryRunner.query(`ALTER TABLE oidc_authorization_codes ADD COLUMN IF NOT EXISTS required_app_slug varchar(60) NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_web_login_tickets_client_created ON web_login_tickets (client_ip, created_at)`);
    await queryRunner.query(`ALTER TABLE external_access_apps ALTER COLUMN session_duration SET DEFAULT '1h'`);
    await queryRunner.query(`UPDATE external_access_apps SET session_duration = '1h', updated_at = now() WHERE session_duration IN ('8h', '12h', '24h')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_web_login_tickets_client_created`);
    await queryRunner.query(`ALTER TABLE external_access_apps ALTER COLUMN session_duration SET DEFAULT '8h'`);
    await queryRunner.query(`ALTER TABLE oidc_authorization_codes DROP COLUMN IF EXISTS required_app_slug`);
    await queryRunner.query(`ALTER TABLE oidc_authorization_codes DROP COLUMN IF EXISTS required_app_id`);
    await queryRunner.query(`ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS confirmation_code`);
    await queryRunner.query(`ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS browser_secret_hash`);
    await queryRunner.query(`ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS scanned_by_user_id`);
  }
}
