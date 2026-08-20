import { Entity, Column, Index, OneToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { User } from './user.entity';

/** 员工档案：工种、责任片区，用于自动派单匹配 */
@Entity('staff_profiles')
@Index(['tenantId'])
export class StaffProfile extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  // 工种编码数组（对应 dict_items type=skill），支持多工种
  @Column({ type: 'jsonb', default: () => "'[]'" })
  skills: string[];

  // 责任片区编码数组（对应 community.zones）
  @Column({ type: 'jsonb', default: () => "'[]'" })
  zones: string[];

  // 管理的仓库 ID 数组（绑定后即该仓仓管，负责收货入库、发起/接收调拨）
  @Column({ name: 'warehouse_ids', type: 'jsonb', default: () => "'[]'" })
  warehouseIds: number[];

  // 是否在岗（派单时排除离岗）
  @Column({ name: 'on_duty', default: true })
  onDuty: boolean;
}
