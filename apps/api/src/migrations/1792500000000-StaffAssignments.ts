import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 员工工作范围（员工 × 管理处 × 工种）。数据范围从角色挪到这里，角色只管能做什么。
 * 生产库由 synchronize 建表、AccessService 启动时按角色旧范围回填；本迁移供开发/测试库使用。
 */
export class StaffAssignments1792500000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS staff_assignments (
      id serial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by integer NULL,
      updated_by integer NULL,
      tenant_id integer NOT NULL,
      user_id integer NOT NULL,
      office_id integer NULL,
      skills jsonb NOT NULL DEFAULT '[]'
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_staff_assignments_user ON staff_assignments (tenant_id, user_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_staff_assignments_office ON staff_assignments (tenant_id, office_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS staff_assignments`);
  }
}
