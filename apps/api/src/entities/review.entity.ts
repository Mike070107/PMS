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
}
