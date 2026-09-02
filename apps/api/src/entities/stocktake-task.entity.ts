import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type StocktakeStatus = 'counting' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

/** 一次仓库盘点任务。账面数量在创建时快照，复核通过后才调整库存。 */
@Entity('stocktake_tasks')
@Index(['tenantId', 'taskNo'], { unique: true })
@Index(['tenantId', 'warehouseId', 'status'])
export class StocktakeTask extends TenantEntity {
  @Column({ name: 'task_no', type: 'varchar', length: 40 })
  taskNo: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ type: 'varchar', length: 20, default: 'counting' })
  status: StocktakeStatus;

  @Column({ name: 'total_count', type: 'int', default: 0 })
  totalCount: number;

  @Column({ name: 'counted_count', type: 'int', default: 0 })
  countedCount: number;

  @Column({ name: 'difference_count', type: 'int', default: 0 })
  differenceCount: number;

  @Column({ name: 'snapshot_at', type: 'timestamptz' })
  snapshotAt: Date;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewer_id', type: 'int', nullable: true })
  reviewerId: number | null;

  @Column({ name: 'review_note', type: 'varchar', length: 500, nullable: true })
  reviewNote: string | null;
}
