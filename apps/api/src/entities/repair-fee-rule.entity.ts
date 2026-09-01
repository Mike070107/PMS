import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 维修收费建议规则。AI 只能选择这里已有的规则，不能自己编金额。 */
@Entity('repair_fee_rules')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'code'], { unique: true })
export class RepairFeeRule extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'repair_type', type: 'varchar', length: 60, nullable: true })
  repairType: string | null;

  /** null = 公司通用；有值 = 仅该管理处。管理处规则优先级由提示词中的适用范围保证 */
  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  keywords: string[];

  @Column({ name: 'fee_cents', type: 'int' })
  feeCents: number;

  @Column({ default: true })
  enabled: boolean;
}
