import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type ParkingOwnerUpdateStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ParkingOwnerValues {
  name: string | null;
  phone: string | null;
  room: string | null;
  note: string | null;
}

export interface ParkingOwnerFieldHints {
  name?: string | null;
  phone?: string | null;
  room?: string | null;
  note?: string | null;
}

/** PMS 与现场停车网关之间的旧库住户资料更新任务。 */
@Entity('parking_owner_updates')
@Index(['tenantId', 'status', 'createdAt'])
@Index(['tenantId', 'idempotencyKey'], { unique: true })
export class ParkingOwnerUpdate extends TenantEntity {
  @Column({ type: 'varchar', length: 80 })
  database: string;

  @Column({ name: 'external_owner_id', type: 'varchar', length: 100 })
  externalOwnerId: string;

  @Column({ name: 'pms_user_id', type: 'int', nullable: true })
  pmsUserId: number | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 80 })
  idempotencyKey: string;

  @Column({ name: 'expected_values', type: 'jsonb' })
  expectedValues: ParkingOwnerValues;

  @Column({ name: 'requested_values', type: 'jsonb' })
  requestedValues: ParkingOwnerValues;

  @Column({ name: 'field_hints', type: 'jsonb', default: () => "'{}'" })
  fieldHints: ParkingOwnerFieldHints;

  @Column({ name: 'result_values', type: 'jsonb', nullable: true })
  resultValues: ParkingOwnerValues | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ParkingOwnerUpdateStatus;

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
