import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { WorkOrderStatus } from '../common/enums';

/** 工单状态变更与操作流水 */
@Entity('work_order_logs')
@Index(['tenantId', 'workOrderId'])
export class WorkOrderLog extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'from_status', type: 'varchar', length: 24, nullable: true })
  fromStatus: WorkOrderStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 24 })
  toStatus: WorkOrderStatus;

  // 操作动作描述，如 auto_dispatch / accept / transfer / complete / need_material / review
  @Column({ type: 'varchar', length: 40 })
  action: string;

  @Column({ name: 'operator_id', type: 'int', nullable: true })
  operatorId: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** 维修过程照片；与完工照片分开，按时间节点展示。 */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];
}
