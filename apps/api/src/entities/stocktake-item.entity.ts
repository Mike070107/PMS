import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 盘点任务中的一条材料快照与实盘结果。 */
@Entity('stocktake_items')
@Index(['tenantId', 'taskId', 'materialId'], { unique: true })
@Index(['tenantId', 'taskId', 'countedAt'])
export class StocktakeItem extends TenantEntity {
  @Column({ name: 'task_id', type: 'int' })
  taskId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  @Column({ name: 'location_id', type: 'int', nullable: true })
  locationId: number | null;

  @Column({ name: 'location_label', type: 'varchar', length: 200, nullable: true })
  locationLabel: string | null;

  @Column({ name: 'book_qty', type: 'numeric', precision: 12, scale: 2 })
  bookQty: number;

  @Column({ name: 'actual_qty', type: 'numeric', precision: 12, scale: 2, nullable: true })
  actualQty: number | null;

  @Column({ name: 'difference_qty', type: 'numeric', precision: 12, scale: 2, nullable: true })
  differenceQty: number | null;

  @Column({ name: 'reason_code', type: 'varchar', length: 40, nullable: true })
  reasonCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];

  @Column({ name: 'counted_by', type: 'int', nullable: true })
  countedBy: number | null;

  @Column({ name: 'counted_at', type: 'timestamptz', nullable: true })
  countedAt: Date | null;
}
