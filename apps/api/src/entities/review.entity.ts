import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 业主验收评价 */
@Entity('reviews')
@Index(['tenantId', 'workOrderId'])
export class Review extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'owner_id', type: 'int' })
  ownerId: number;

  // 1-5 星
  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];

  // 是否为超过租户配置时限后的系统自动验收
  @Column({ name: 'auto_confirmed', default: false })
  autoConfirmed: boolean;

  /**
   * active=当前有效；reversed=工单被撤回验收后失效。
   *
   * 撤回**不删** Review：原星级、文字、图片、验收人、验收时间都是业主真实留下的记录，
   * 删掉之后没人能解释「这单当初到底几星」。评分统计一律只算 active。
   */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: 'active' | 'reversed';

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  /** 让它失效的那条 work_order_logs.id */
  @Column({ name: 'reversed_by_log_id', type: 'int', nullable: true })
  reversedByLogId: number | null;
}
