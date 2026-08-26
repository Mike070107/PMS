import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 角色回归成「一个名字 + 勾好的页面 + 数据范围」（2026-08-26）。
 *
 * 短暂存在过一个 roles.business_role（「角色类型」），用来区分
 * 「接单还是派单」「采购审批谁批第一步」。这两件事已经拆成各自的可勾选入口
 * （app:pool / app:dispatch / app:approve-manager / app:approve-purchaser），
 * 类型字段就是多余的一层：配角色不该先填一个类型。
 *
 * users.role 同时降级为「哪个端」：owner / staff / superadmin。
 * 员工能干什么，只看他绑的角色 —— 接口鉴权也全部改成读权限矩阵。
 */
export class RoleIsJustAName1787788800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_roles_tenant_business_role`);
    await queryRunner.query(`ALTER TABLE roles DROP COLUMN IF EXISTS business_role`);

    // 补种标记：开箱即用的那批角色每个公司只种一次，
    // 否则企业超管后来的调整（改名、取消入口、停用）会在下次重启被悄悄改回去
    await queryRunner.query(
      `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS rbac_seeded_at timestamptz`,
    );

    // 旧的员工身份（technician/office/manager/purchaser/guard…）统一成 staff。
    // 具体能干什么由角色绑定决定，绑定由启动种子按旧身份补上（rbac-seed.service）。
    // 注意顺序：种子先按旧值绑角色，再归一 —— 所以这里**不动**数据，
    // 只把列注释改掉，真正的归一在种子里做（它能同时把角色绑上）。
    await queryRunner.query(
      `COMMENT ON COLUMN users.role IS '哪个端：owner / staff / superadmin。员工能干什么看角色绑定'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS rbac_seeded_at`);
    await queryRunner.query(
      `ALTER TABLE roles ADD COLUMN IF NOT EXISTS business_role varchar(20)`,
    );
  }
}
