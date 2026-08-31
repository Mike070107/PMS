import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { RepairSource } from '../common/enums';

/** 业主/办公室提交的原始报修，保留提交时的完整快照 */
@Entity('repair_requests')
@Index(['tenantId', 'communityId'])
export class RepairRequest extends TenantEntity {
  @Column({ type: 'varchar', length: 20 })
  source: RepairSource;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'building_id', type: 'int', nullable: true })
  buildingId: number | null;

  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  // 提交时定位文本快照（弄/号/房号）
  @Column({ name: 'address_text', type: 'varchar', length: 255, nullable: true })
  addressText: string | null;

  @Column({ name: 'contact_name', type: 'varchar', length: 60, nullable: true })
  contactName: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 30, nullable: true })
  contactPhone: string | null;

  /**
   * 报修人身份（UserRole 编码）。业主本人报的留空。
   * 保安/居委会/业委会代报时必须标出来：办公室看到「张三（保安）」才知道
   * 电话打过去的是代报的人，需要住户配合时得另找业主，不会误以为这是业主本人。
   */
  @Column({ name: 'reporter_role', type: 'varchar', length: 20, nullable: true })
  reporterRole: string | null;

  // 报修类型（dict type=repair_type 编码），用于映射工种做派单
  @Column({ name: 'repair_type', type: 'varchar', length: 60, nullable: true })
  repairType: string | null;

  @Column({ type: 'text' })
  content: string;

  /**
   * 报修时就要求当紧急处理。来源有二：描述里说了「急修 / 加急 / 抢修」
   * （见 shared-types 的 detectUrgency，端上和服务端同一份口径），
   * 或者报单的人自己勾了。工单池、在手工单、后台列表都靠它挂红色「紧急」标。
   */
  @Column({ type: 'boolean', default: false })
  urgent: boolean;

  // 附件 URL 数组（图片/视频）
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];

  // 提交人 user id（业主或办公室人员）
  @Column({ name: 'submitted_by', type: 'int', nullable: true })
  submittedBy: number | null;
}
