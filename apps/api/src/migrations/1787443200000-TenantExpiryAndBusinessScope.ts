import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SaaS 层级补齐（2026-08-19，设计见 docs/rbac-design.md 补充节）：
 * 1. tenants.expires_at —— 平台给物业公司设的服务有效期（null = 永久），
 *    到期后该公司全员请求在 JWT 层拦截。
 * 2. business_transactions.community_id —— 收费流水补小区维度，
 *    让前台收费与工单等模块走同一套数据范围过滤；存量流水按房号回填。
 */
export class TenantExpiryAndBusinessScope1787443200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expires_at date`,
    );
    await queryRunner.query(
      `ALTER TABLE business_transactions ADD COLUMN IF NOT EXISTS community_id int`,
    );
    // 存量流水回填：房号 → 楼栋 → 小区
    await queryRunner.query(`
      UPDATE business_transactions bt
      SET community_id = b.community_id
      FROM houses h
      JOIN buildings b ON b.id = h.building_id
      WHERE bt.house_id = h.id AND bt.community_id IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_business_txns_tenant_community ON business_transactions (tenant_id, community_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_business_txns_tenant_community`,
    );
    await queryRunner.query(
      `ALTER TABLE business_transactions DROP COLUMN IF EXISTS community_id`,
    );
    await queryRunner.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS expires_at`);
  }
}
