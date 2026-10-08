import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 二维码票据仍由浏览器私密 Cookie、一次性随机 ticket、首次扫码者绑定保护。
 * 移除只靠人工比对的四位核对码，避免把无实际校验价值的信息塞进登录流程。
 */
export class RemoveQrConfirmationCode1790121600000 implements MigrationInterface {
  name = 'RemoveQrConfirmationCode1790121600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE web_login_tickets DROP COLUMN IF EXISTS confirmation_code');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE web_login_tickets ADD COLUMN IF NOT EXISTS confirmation_code char(4) NULL');
  }
}
