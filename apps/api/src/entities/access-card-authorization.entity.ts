import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type AccessCardAuthorizationStatus = 'pending' | 'running' | 'completed' | 'failed';

/** 已发卡片追加门栋权限；独立于发卡批次，避免污染发卡数量和旧库用户序号。 */
@Entity('access_card_authorizations')
@Index(['tenantId', 'status', 'createdAt'])
@Index(['tenantId', 'idempotencyKey'], { unique: true })
export class AccessCardAuthorization extends TenantEntity {
  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  @Column({ name: 'history_row_id', type: 'int' })
  historyRowId: number;

  @Column({ name: 'room_key', type: 'varchar', length: 100 })
  roomKey: string;

  @Column({ name: 'ic_card_no', type: 'varchar', length: 40, nullable: true })
  icCardNo: string | null;

  @Column({ name: 'wg_card_no', type: 'varchar', length: 40 })
  wgCardNo: string;

  @Column({ name: 'target_buildings', type: 'jsonb', default: () => "'[]'" })
  targetBuildings: Array<{ id: number; buildingNo: string; accessSystem: 'mjsystem' | 'iccard' }>;

  @Column({ name: 'controller_results', type: 'jsonb', default: () => "'[]'" })
  controllerResults: Array<Record<string, unknown>>;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: AccessCardAuthorizationStatus;

  @Column({ type: 'int', default: 0 })
  attempt: number;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'lease_agent_key', type: 'varchar', length: 80, nullable: true })
  leaseAgentKey: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;
}
