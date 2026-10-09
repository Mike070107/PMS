import { MigrationInterface, QueryRunner } from 'typeorm';

/** 一个可读的客户端名称只对应同一企业的一台受管设备，避免发布时选错电脑。 */
export class UniqueLanGatewayAgentNames1791582000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lan_gateway_agents_tenant_name_unique ON lan_gateway_agents (tenant_id, name)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_lan_gateway_agents_tenant_name_unique`);
  }
}
