import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 小区。支持两层：
 * - 上级（分组，parentId = null 且有子节点）：如「枫桦景苑」，本身不挂楼栋
 * - 下级（分期，parentId 指向分组）：如「枫桦景苑一期」「枫桦景苑二期」，楼栋/房产挂在这一层
 * 只有一层时 parentId 为 null，行为与旧数据完全一致。
 */
@Entity('communities')
@Index(['tenantId'])
export class Community extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** 上级小区（分组）。null = 本身是顶层 */
  @Column({ name: 'parent_id', type: 'int', nullable: true })
  parentId: number | null;

  /** 所属物业管理处（仅顶层小区填，分期跟随其顶层）。null = 未划入任何管理处 */
  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

  @ManyToOne(() => Community, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Community | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address: string | null;

  // 责任片区划分（自动派单用），存片区编码数组
  @Column({ name: 'zones', type: 'jsonb', default: () => "'[]'" })
  zones: string[];

  @Column({ default: true })
  enabled: boolean;
}
