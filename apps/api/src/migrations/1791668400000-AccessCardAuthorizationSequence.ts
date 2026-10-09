import { MigrationInterface, QueryRunner } from 'typeorm';

/** 保存历史卡在房号下的累计序号，供 .88 门禁软件显示完整用户姓名。 */
export class AccessCardAuthorizationSequence1791668400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE access_card_authorizations ADD COLUMN IF NOT EXISTS card_sequence integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE access_card_authorizations DROP COLUMN IF EXISTS card_sequence`);
  }
}
