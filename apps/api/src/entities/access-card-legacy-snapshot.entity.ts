import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export interface AccessCardLegacyHistoryEntry {
  personId: number;
  personNo: string;
  sequence: number;
  icCardNo: string | null;
  issuedAt: string | null;
}

export interface AccessCardPermissionEntry {
  [key: string]: unknown;
  wgCardNo: string;
  accessSystem: 'mjsystem' | 'iccard';
  buildingNo: string | null;
  controller: string | null;
  door: string;
  sourceTable: 'MJ_MacPower' | 't_d_Privilege';
}

export interface AccessCardPermissionSubject {
  icCardNo: string;
  wgCardNo: string;
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

  /** 二期楼栋门禁库的只读权限核验；和 .80 历史查询使用独立租约。 */
  @Column({ name: 'permission_status', type: 'varchar', length: 20, default: 'idle' })
  permissionStatus: 'idle' | 'pending' | 'running' | 'ready' | 'error';

  @Column({ name: 'permission_subjects', type: 'jsonb', default: () => "'[]'" })
  permissionSubjects: AccessCardPermissionSubject[];

  @Column({ name: 'permissions', type: 'jsonb', default: () => "'[]'" })
  permissions: AccessCardPermissionEntry[];

  @Column({ name: 'permission_requested_at', type: 'timestamptz', nullable: true })
  permissionRequestedAt: Date | null;

  @Column({ name: 'permission_refreshed_at', type: 'timestamptz', nullable: true })
  permissionRefreshedAt: Date | null;

  @Column({ name: 'permission_lease_agent_key', type: 'varchar', length: 80, nullable: true })
  permissionLeaseAgentKey: string | null;

  @Column({ name: 'permission_lease_expires_at', type: 'timestamptz', nullable: true })
  permissionLeaseExpiresAt: Date | null;

  @Column({ name: 'permission_last_error', type: 'varchar', length: 500, nullable: true })
  permissionLastError: string | null;
}
