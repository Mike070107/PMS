import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 微信订阅消息授权余量。
 * 每次用户在小程序点"允许接收"某模板，余量 +1；推送一次扣 1。
 * 余量不足时降级为站内消息。
 */
@Entity('subscription_grants')
@Index(['tenantId', 'userId'])
@Index(['userId', 'templateId'], { unique: true })
export class SubscriptionGrant extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  // 微信订阅消息 template_id
  @Column({ name: 'template_id', type: 'varchar', length: 64 })
  templateId: string;

  @Column({ name: 'remaining', type: 'int', default: 0 })
  remaining: number;
}
