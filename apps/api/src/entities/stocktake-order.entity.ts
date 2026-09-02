import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { StocktakeOrderStatus } from '../common/enums';

/**
 * 盘点单：对一个仓做一次完整盘点（建单快照账面 → 现场分批录实盘数 → 经理审核 → 过账）。
 *
 * 流转：counting → pending_review → approved；退回不作废、回到 counting 改数；
 * counting 状态可作废（cancelled）。同一个仓同时只允许一张在途单（counting/pending_review）。
 *
 * 与单条盘点调整（PATCH /stocks/:id）的分工：那是日常零星纠错，这里是成批月末盘点，
 * 有单据留痕和审核环节。两者过账最终都走 stock-ledger 的盘盈/盘亏，写 ADJUST 流水。
 */
@Entity('stocktake_orders')
@Index(['tenantId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'warehouseId'])
export class StocktakeOrder extends TenantEntity {
  @Column({ name: 'stocktake_no', type: 'varchar', length: 40 })
  stocktakeNo: string;

  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  /**
   * 盘点明细。建单时按当时该仓全部库存行快照生成（snapshotQty，含 qty=0 的行）；
   * 账上没有、实物有的材料可在录入时补行（snapshotQty 取当时系统数，多为 0）。
   *
   * 差异一律按**过账时刻**的系统数量（systemQty）算，不是建单快照 ——
   * 盘点期间不锁仓、照常出入库，快照只用来在界面上提示「这行盘点期间动过」。
   * systemQty / diffQty / unitCostCents / amountCents 都是过账时写入的快照，
   * 与 stock_movements 同一口径，报表读快照、不回头现算（见 docs/inventory-costing.md）。
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: Array<{
    materialId: number;
    snapshotQty: number;
    /** 实盘数量；null/缺省 = 这行还没盘到，过账不动它 */
    countedQty?: number | null;
    countedBy?: number | null;
    countedAt?: string | null;
    note?: string | null;
    // ---- 以下过账时写入 ----
    systemQty?: number;
    diffQty?: number;
    unitCostCents?: number;
    amountCents?: number;
  }>;

  @Column({ type: 'varchar', length: 20, default: StocktakeOrderStatus.COUNTING })
  status: StocktakeOrderStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  /** 最近一次审核退回的原因；重新提交后保留，界面上仍能看到上一轮为什么被退 */
  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason: string | null;

  /** 建单人（通常也是盘点人；具体每行谁盘的在 items[].countedBy） */
  @Column({ name: 'applicant_id', type: 'int', nullable: true })
  applicantId: number | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  /** 审核人（物业经理） */
  @Column({ name: 'approver_id', type: 'int', nullable: true })
  approverId: number | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;
}
