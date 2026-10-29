import { MigrationInterface, QueryRunner } from 'typeorm';

/** 内网应用登录有效期只保留 4 / 8 / 12 小时，默认 8 小时；旧的 30 分钟、1 小时改为 8 小时。 */
export class GatewaySessionDurations1792600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE external_access_apps ALTER COLUMN session_duration SET DEFAULT '8h'`);
    await queryRunner.query(`UPDATE external_access_apps SET session_duration = '8h', updated_at = now() WHERE session_duration NOT IN ('4h', '8h', '12h')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE external_access_apps ALTER COLUMN session_duration SET DEFAULT '1h'`);
  }
}
