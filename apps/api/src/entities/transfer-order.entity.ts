import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { TransferOrderStatus } from '../common/enums';

/**
 * 调拨单：默认往外调（发货仓 → 接收仓）。
 * 流转：pending_review → approved（经理审批通过，发货仓扣减、在途）→ received（接收仓确认实收）
 * 旁路：rejected（经理驳回）
 */
@Entity('transfer_orders')
@Index(['tenantId'])
@Index(['tenantId', 'status'])
export class TransferOrder extends TenantEntity {
  @Column({ name: 'transfer_no', type: 'varchar', length: 40 })
  transferNo: string;

  @Column({ name: 'from_warehouse_id', type: 'int' })
  fromWarehouseId: number;

  @Column({ name: 'to_warehouse_id', type: 'int' })
  toWarehouseId: number;

  // 明细：[{materialId, qty, receivedQty?, allocations?}]
  // qty=申请数量；receivedQty=接收仓实收数量（接收时填写，可小于 qty）
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: Array<{
    materialId: number;
    qty: number;
    receivedQty?: number;
    allocations?: Array<{ stockLotId: number; qty: number; unitCostCents: number; amountCents: number }>;
  }>;

  @Column({ type: 'varchar', length: 20, default: TransferOrderStatus.PENDING_REVIEW })
  status: TransferOrderStatus;

  // 发起人（发货仓发货人）
  @Column({ name: 'applicant_id', type: 'int', nullable: true })
  applicantId: number | null;

  // 审批人（物业经理）
  @Column({ name: 'approver_id', type: 'int', nullable: true })
  approverId: number | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  // 接收人（接收仓仓管）
  @Column({ name: 'receiver_id', type: 'int', nullable: true })
  receiverId: number | null;

  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason: string | null;

  @Column({ name: 'note', type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @Column({ name: 'shipped_at', type: 'timestamptz', nullable: true })
  shippedAt: Date | null;

  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;
}
