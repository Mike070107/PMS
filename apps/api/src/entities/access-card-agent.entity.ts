import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type AccessCardAgentKind = 'issuer' | 'access_gateway' | 'legacy_sync' | 'parking_gateway';

/** 发卡电脑、门禁网关、旧库同步和停车双库网关的注册信息。 */
@Entity('access_card_agents')
@Index(['tenantId', 'agentKey'], { unique: true })
export class AccessCardAgent extends TenantEntity {
  @Column({ name: 'agent_key', type: 'varchar', length: 80 })
  agentKey: string;

  @Column({ type: 'varchar', length: 30 })
  kind: AccessCardAgentKind;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 30 })
  version: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', length: 30, default: 'offline' })
  status: 'online' | 'offline' | 'degraded';

  @Column({ type: 'jsonb', default: () => "'{}'" })
  capabilities: Record<string, boolean>;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;
}
