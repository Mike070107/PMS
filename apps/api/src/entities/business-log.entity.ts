import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 业务办理操作日志，后续对接外部系统/发票也写在这里 */
@Entity('business_logs')
@Index(['tenantId', 'transactionId'])
export class BusinessLog extends TenantEntity {
  @Column({ name: 'transaction_id', type: 'int', nullable: true })
  transactionId: number | null;

  @Column({ type: 'varchar', length: 60 })
  action: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  detail: Record<string, unknown>;
}
