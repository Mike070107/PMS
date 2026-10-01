import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type ParkingOperationKind =
  | 'add_vehicle'
  | 'renew_vehicle'
  | 'change_plate'
  | 'rebind_owner'
  | 'update_garages'
  | 'download_vehicle'
  | 'delete_vehicle';
export type ParkingOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 网页只写入任务，现场助手必须通过旧系统存储过程执行。 */
@Entity('parking_operations')
@Index(['tenantId', 'status', 'createdAt'])
@Index(['tenantId', 'idempotencyKey'], { unique: true })
export class ParkingOperation extends TenantEntity {
  @Column({ type: 'varchar', length: 30 })
  kind: ParkingOperationKind;
  @Column({ type: 'varchar', length: 80 })
  database: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey: string;
  @Column({ name: 'source_record_id', type: 'varchar', length: 100, nullable: true })
  sourceRecordId: string | null;
  @Column({ name: 'pms_user_id', type: 'int', nullable: true })
  pmsUserId: number | null;
  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'{}'" })
  expected: Record<string, unknown>;
  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ParkingOperationStatus;
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
  @Column({ name: 'rollback_of_operation_id', type: 'int', nullable: true })
  rollbackOfOperationId: number | null;
}
