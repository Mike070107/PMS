import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type ParkingQueryStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ParkingQueryRow {
  database: string;
  fields: Record<string, string | number | boolean | null>;
}

/** 网页与现场停车网关之间的短期只读查询任务。 */
@Entity('parking_queries')
@Index(['tenantId', 'status', 'createdAt'])
export class ParkingQuery extends TenantEntity {
  @Column({ type: 'varchar', length: 80 })
  term: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ParkingQueryStatus;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  rows: ParkingQueryRow[];

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
