import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type LanGatewayAgentStatus = 'pending' | 'online' | 'offline' | 'degraded' | 'disabled';

/** 一台受 PMS 控制面管理的局域网发布助手。 */
@Entity('lan_gateway_agents')
@Index(['tenantId', 'name'])
@Index(['deviceKey'], { unique: true })
export class LanGatewayAgent extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'device_key', type: 'varchar', length: 80 })
  deviceKey: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64, nullable: true })
  tokenHash: string | null;

  @Column({ name: 'install_code_hash', type: 'varchar', length: 64, nullable: true })
  installCodeHash: string | null;

  @Column({ name: 'install_code_expires_at', type: 'timestamptz', nullable: true })
  installCodeExpiresAt: Date | null;

  @Column({ name: 'enrolled_at', type: 'timestamptz', nullable: true })
  enrolledAt: Date | null;

  @Column({ type: 'varchar', length: 30, default: 'pending' })
  status: LanGatewayAgentStatus;

  @Column({ type: 'varchar', length: 30, nullable: true })
  version: string | null;

  @Column({ name: 'computer_name', type: 'varchar', length: 120, nullable: true })
  computerName: string | null;

  @Column({ name: 'desired_revision', type: 'integer', default: 0 })
  desiredRevision: number;

  @Column({ name: 'applied_revision', type: 'integer', default: 0 })
  appliedRevision: number;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
