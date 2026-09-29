import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type AccessCardLegacyCardCheckStatus = 'pending' | 'clear' | 'duplicate' | 'error';

export interface AccessCardLegacyCardMatch {
  personId: number;
  personNo: string;
  personName: string;
  icCardNo: string;
  issuedAt: string | null;
}

/** A one-card, global JSOCTNet lookup completed by the .80 agent before any write. */
@Entity('access_card_legacy_card_checks')
@Index(['itemId'], { unique: true })
export class AccessCardLegacyCardCheck extends TenantEntity {
  @Column({ name: 'item_id', type: 'int' })
  itemId: number;

  @Column({ name: 'ic_card_no', type: 'varchar', length: 40 })
  icCardNo: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: AccessCardLegacyCardCheckStatus;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  matches: AccessCardLegacyCardMatch[];

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  @Column({ name: 'checked_at', type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Column({ name: 'lease_agent_key', type: 'varchar', length: 80, nullable: true })
  leaseAgentKey: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;
}
