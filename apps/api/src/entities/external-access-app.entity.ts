import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 一条“外网域名 → Tunnel → 内网网站”的标准化发布配置。 */
@Entity('external_access_apps')
@Index(['tenantId', 'slug'], { unique: true })
@Index(['publicHostname'], { unique: true })
export class ExternalAccessApp extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'public_hostname', type: 'varchar', length: 255 })
  publicHostname: string;

  @Column({ name: 'origin_url', type: 'varchar', length: 500 })
  originUrl: string;

  @Column({ name: 'entry_path', type: 'varchar', length: 1000, default: '/' })
  entryPath: string;

  @Column({ name: 'session_duration', type: 'varchar', length: 20, default: '1h' })
  sessionDuration: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'agent_id', type: 'integer', nullable: true })
  agentId: number | null;

  @Column({ name: 'gateway_port', type: 'integer', nullable: true, unique: true })
  gatewayPort: number | null;

  @Column({ name: 'publish_status', type: 'varchar', length: 30, default: 'draft' })
  publishStatus: 'draft' | 'waiting_agent' | 'publishing' | 'online' | 'error' | 'disabled';

  @Column({ name: 'desired_revision', type: 'integer', default: 0 })
  desiredRevision: number;

  @Column({ name: 'applied_revision', type: 'integer', default: 0 })
  appliedRevision: number;

  @Column({ name: 'origin_checked_at', type: 'timestamptz', nullable: true })
  originCheckedAt: Date | null;

  @Column({ name: 'cloudflare_app_id', type: 'varchar', length: 64, nullable: true })
  cloudflareAppId: string | null;

  @Column({ name: 'cloudflare_policy_id', type: 'varchar', length: 64, nullable: true })
  cloudflarePolicyId: string | null;

  @Column({ name: 'cloudflare_dns_record_id', type: 'varchar', length: 64, nullable: true })
  cloudflareDnsRecordId: string | null;

  @Column({ name: 'last_synced_at', type: 'timestamptz', nullable: true })
  lastSyncedAt: Date | null;

  @Column({ name: 'last_sync_error', type: 'varchar', length: 1000, nullable: true })
  lastSyncError: string | null;
}
