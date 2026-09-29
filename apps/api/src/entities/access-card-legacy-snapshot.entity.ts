import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export interface AccessCardLegacyHistoryEntry {
  personId: number;
  personNo: string;
  sequence: number;
  icCardNo: string | null;
  issuedAt: string | null;
}

/** .80 旧库的按房号只读快照；由 legacy_sync 代理刷新。 */
@Entity('access_card_legacy_snapshots')
@Index(['tenantId', 'roomKey'], { unique: true })
export class AccessCardLegacySnapshot extends TenantEntity {
  @Column({ name: 'room_key', type: 'varchar', length: 100 })
  roomKey: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: 'pending' | 'ready' | 'error';

  @Column({ type: 'jsonb', default: () => "'[]'" })
  history: AccessCardLegacyHistoryEntry[];

  @Column({ name: 'issued_count', type: 'int', default: 0 })
  issuedCount: number;

  @Column({ name: 'next_sequence', type: 'int', default: 1 })
  nextSequence: number;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  @Column({ name: 'refreshed_at', type: 'timestamptz', nullable: true })
  refreshedAt: Date | null;

  @Column({ name: 'lease_agent_key', type: 'varchar', length: 80, nullable: true })
  leaseAgentKey: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;
}
