import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { PurchaseRequestStatus } from '../common/enums';

/**
 * 采购申请。三级流转：
 * 申请人(维修工/办公室) → 物业经理 → 采购经理 → 下单
 * 金额阈值以下可配跳过采购经理。
 */
@Entity('purchase_requests')
@Index(['tenantId', 'status'])
export class PurchaseRequest extends TenantEntity {
  @Column({ name: 'request_no', type: 'varchar', length: 40 })
  requestNo: string;

  // 关联触发的工单（缺料场景），手工申请时为 null
  @Column({ name: 'work_order_id', type: 'int', nullable: true })
  workOrderId: number | null;

  @Column({ name: 'applicant_id', type: 'int' })
  applicantId: number;

  // 明细：[{materialId, name, qty, unit, estUnitCostCents}]
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: Array<{
    lineId?: string;
    materialId?: number;
    warehouseId?: number;
    name: string;
    qty: number;
    unit?: string;
    estUnitCostCents?: number;
    sourceRequestId?: number;
    sourceRequestNo?: string;
    sourceWorkOrderId?: number | null;
    rejectReason?: string;
    rejectedAtStage?: 'manager' | 'purchaser';
  }>;

  // 预估总额（分），决定是否走采购经理审批
  @Column({ name: 'est_total_cents', type: 'int', default: 0 })
  estTotalCents: number;

  @Column({ type: 'varchar', length: 24, default: PurchaseRequestStatus.DRAFT })
  status: PurchaseRequestStatus;

  @Column({ name: 'manager_id', type: 'int', nullable: true })
  managerId: number | null;

  @Column({ name: 'manager_at', type: 'timestamptz', nullable: true })
  managerAt: Date | null;

  @Column({ name: 'purchaser_id', type: 'int', nullable: true })
  purchaserId: number | null;

  @Column({ name: 'purchaser_at', type: 'timestamptz', nullable: true })
  purchaserAt: Date | null;

  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason: string | null;
}
