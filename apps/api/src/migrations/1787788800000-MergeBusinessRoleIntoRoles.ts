import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 业务身份与后台角色合并（2026-08-26）。
 *
 * 此前是双轨：users.role 管「干哪一行」（接单/派单/审批链/登录哪个端），
 * roles 表管「网站上能看哪一页」。后果是后台改了角色，员工端小程序一格没变 ——
 * 底部 tab 按 users.role 判显隐，压根不读权限矩阵，用户合理地认为「角色没生效」。
 *
 * 现在 roles 表加 business_role：后台只剩「角色」一个概念，建角色时选业务身份。
 * users.role 保留为派生列（绑角色时后端同步写入），因为 @Roles、jwt、
 * 小程序登录跳转、SELF_SCOPED_ROLES 数据隔离都读它，业主也根本不绑角色。
 *
 * 存量数据的角色补种与绑定迁移放在 RbacSeedService（幂等、每次启动跑），
 * 这里只加列 —— 种子里能读到 USER_ROLE_LABELS 等常量，SQL 里硬编码一份必然走样。
 */
export class MergeBusinessRoleIntoRoles1787788800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE roles ADD COLUMN IF NOT EXISTS business_role varchar(20)`,
    );
    // 同一个身份**允许**有多个角色：各管理处常要各自的「维修工」（数据范围不同、
    // 小程序入口也可能不同）。真正必须唯一的是「一个人只能绑一个带身份的角色」，
    // 那条在保存用户时校验（staff.service 的 assertSingleIdentity）。
    // 早期版本在这里建过唯一索引，会让「新建枫桦景苑维修工」直接 400，故显式删掉。
    await queryRunner.query(`DROP INDEX IF EXISTS uq_roles_tenant_business_role`);

    // 迁移标记：身份角色的补种只做一次。做成每次启动都跑会把企业超管后来的
    // 调整（清空身份、取消入口、停用角色）在下次重启时悄悄回滚。
    await queryRunner.query(
      `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS rbac_seeded_at timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS rbac_seeded_at`);
    await queryRunner.query(`ALTER TABLE roles DROP COLUMN IF EXISTS business_role`);
  }
}
