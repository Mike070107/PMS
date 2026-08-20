import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { BusinessServiceType, BusinessTransactionStatus } from '../common/enums';

/** 一笔已收费并完成外部联动的业务办理记录 */
@Entity('business_transactions')
@Index(['tenantId', 'serviceType'])
@Index(['tenantId', 'txnNo'], { unique: true })
export class BusinessTransaction extends TenantEntity {
  @Column({ name: 'txn_no', type: 'varchar', length: 40 })
  txnNo: string;

  @Column({ name: 'service_type', type: 'varchar', length: 40 })
  serviceType: BusinessServiceType;

  @Column({ type: 'varchar', length: 20, default: BusinessTransactionStatus.PAID })
  status: BusinessTransactionStatus;

  @Column({ name: 'rule_id', type: 'int', nullable: true })
  ruleId: number | null;

  /** 办理房号所在小区，随单落库，供角色数据范围过滤 */
  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  @Column({ name: 'owner_id', type: 'int', nullable: true })
  ownerId: number | null;

  @Column({ name: 'target_type', type: 'varchar', length: 30, nullable: true })
  targetType: string | null;

  @Column({ name: 'target_id', type: 'int', nullable: true })
  targetId: number | null;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: string | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: string | null;

  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  @Column({ name: 'payment_method', type: 'varchar', length: 30, nullable: true })
  paymentMethod: string | null;

  @Column({ name: 'external_sync_status', type: 'varchar', length: 20, default: 'mocked' })
  externalSyncStatus: string;

  @Column({ name: 'invoice_status', type: 'varchar', length: 20, default: 'pending' })
  invoiceStatus: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  snapshot: Record<string, unknown>;
}
