import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 员工工作范围：一行 = 这个人在某个管理处做哪些工种。
 *
 * - office_id = null 表示「全部管理处」（如智能化维修工、总公司办公室）；
 * - 同一员工同一管理处只有一行（由 StaffService 保证，PostgreSQL 唯一索引不约束 null）；
 * - 数据范围、派单覆盖、员工所属管理处都从这里算，角色只管能做什么。
 *   规则见 modules/staff/staff-assignment.util.ts。
 */
@Entity('staff_assignments')
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'officeId'])
export class StaffAssignment extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

  /** 在该管理处承担的工种（skill code，如 electric / water / smart） */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  skills: string[];
}
