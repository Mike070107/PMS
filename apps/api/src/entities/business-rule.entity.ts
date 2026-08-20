import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { BusinessBillingUnit, BusinessServiceType } from '../common/enums';

/** 可按租户/小区复用的收费规则 */
@Entity('business_rules')
@Index(['tenantId', 'serviceType'])
export class BusinessRule extends TenantEntity {
  @Column({ name: 'service_type', type: 'varchar', length: 40 })
  serviceType: BusinessServiceType;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  @Column({ name: 'billing_unit', type: 'varchar', length: 20 })
  billingUnit: BusinessBillingUnit;

  @Column({ name: 'unit_price_cents', type: 'int' })
  unitPriceCents: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  config: Record<string, unknown>;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
