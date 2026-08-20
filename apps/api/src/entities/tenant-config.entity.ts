import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 租户级键值配置。已知 key：
 * - dispatch_rules：派单规则权重 { zoneWeight, loadWeight, ratingWeight }
 * - sla_hours：各工种 SLA 时长映射
 * - purchase_threshold_cents：采购金额阈值（低于可跳过采购经理）
 * - wx_template_ids：订阅消息模板 id 映射
 * - auto_review_hours：待业主验收超时自动完成时限 { hours }
 */
@Entity('tenant_configs')
@Index(['tenantId', 'key'], { unique: true })
export class TenantConfig extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'jsonb' })
  value: Record<string, unknown>;
}
