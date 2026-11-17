import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import type { Resource, BusinessCommand, IntegrationOperation } from '../modules/local-integrations/protocol';

@Entity('local_integrations')
@Index(['tenantId', 'name'], { unique: true })
export class LocalIntegration extends TenantEntity {
  @Column({ type: 'varchar', length: 80, unique: true }) key: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 30 }) kind: 'workstation' | 'service';
  @Column({ name: 'token_hash', type: 'varchar', length: 64 }) tokenHash: string;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'jsonb', default: () => "'[]'" }) resources: Resource[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) ready: Resource[];
  @Column({ type: 'varchar', length: 30, default: 'pending' }) version: string;
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true }) lastSeenAt: Date | null;
}

@Entity('local_integration_tasks')
@Index(['tenantId', 'integrationKey', 'idempotencyKey'], { unique: true })
export class LocalIntegrationTask extends TenantEntity {
  @Column({ name: 'integration_key', type: 'varchar', length: 80 }) integrationKey: string;
  @Column({ name: 'resource_id', type: 'varchar', length: 80 }) resourceId: string;
  @Column({ type: 'varchar', length: 50 }) operation: IntegrationOperation;
  @Column({ type: 'int', default: 1 }) revision: number;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 80 }) idempotencyKey: string;
  @Column({ type: 'jsonb' }) command: BusinessCommand;
  @Column({ type: 'varchar', length: 20, default: 'pending' }) status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  @Column({ name: 'lease_token', type: 'varchar', length: 64, nullable: true }) leaseToken: string | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true }) leaseExpiresAt: Date | null;
  @Column({ type: 'jsonb', nullable: true }) result: Record<string, unknown> | null;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ name: 'issuance_item_id', type: 'int', nullable: true }) issuanceItemId: number | null;
  @Column({ name: 'allocation_id', type: 'int', nullable: true }) allocationId: number | null;
}
