import { MigrationInterface, QueryRunner } from 'typeorm';

/** 区分只写 .88 门禁数据库与写库后继续下发控制器。 */
export class AccessCardAuthorizationOperation1791754800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE access_card_authorizations ADD COLUMN IF NOT EXISTS operation varchar(30) NOT NULL DEFAULT 'controller_upload'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE access_card_authorizations DROP COLUMN IF EXISTS operation`);
  }
}
