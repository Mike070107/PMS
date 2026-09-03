import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { StockMovementType } from '../common/enums';

/** 出入库流水（审计用，永不修改） */
@Entity('stock_movements')
@Index(['tenantId', 'warehouseId', 'materialId'])
// 线上 DB_SYNCHRONIZE=true 不跑 migration，唯一索引只有在实体上声明才会被建出来。
// 它是「重复撤回不可能退出第二份库存」的最后一道闸门，不能只写在迁移里。
@Index(['reversalOfMovementId'], {
  unique: true,
  where: '"reversal_of_movement_id" IS NOT NULL',
})
export class StockMovement extends TenantEntity {
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  @Column({ type: 'varchar', length: 20 })
  type: StockMovementType;

  // 正数入库 / 负数出库
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  qty: number;

  @Column({ name: 'unit_cost_cents', type: 'int', default: 0 })
  unitCostCents: number;

  // 来源单据类型与 id，如 work_order / goods_receipt / transfer_order
  @Column({ name: 'ref_type', type: 'varchar', length: 40, nullable: true })
  refType: string | null;

  @Column({ name: 'ref_id', type: 'int', nullable: true })
  refId: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  /**
   * 冲回流水指向被它冲销的那条出库流水。
   *
   * 加了唯一索引（见迁移）：一条扣料流水最多只能被冲销一次，
   * 重复点击撤回、或并发重试都不可能退出第二份库存。
   */
  @Column({ name: 'reversal_of_movement_id', type: 'int', nullable: true })
  reversalOfMovementId: number | null;
}
