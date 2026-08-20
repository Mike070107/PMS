import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { NotifyChannel, NotifyStatus } from '../common/enums';

/** 通知发送记录 */
@Entity('notifications')
@Index(['tenantId', 'receiverId'])
export class Notification extends TenantEntity {
  @Column({ name: 'receiver_id', type: 'int' })
  receiverId: number;

  @Column({ type: 'varchar', length: 20 })
  channel: NotifyChannel;

  // 业务事件 key，如 order_dispatched / order_review / purchase_review
  @Column({ name: 'event_key', type: 'varchar', length: 60 })
  eventKey: string;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: NotifyStatus.PENDING })
  status: NotifyStatus;

  // 站内消息已读标记
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;
}
