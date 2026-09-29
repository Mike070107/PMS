import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { House } from './house.entity';

export type AccessCardProjectPhase = 'phase1' | 'phase2';
export type AccessCardIssueBatchStatus =
  | 'waiting_for_card'
  | 'processing'
  | 'completed'
  | 'needs_operator'
  | 'cancelled';

/** 一次连续发 1–6 张卡的操作批次。 */
@Entity('access_card_issue_batches')
@Index(['tenantId', 'houseId', 'createdAt'])
export class AccessCardIssueBatch extends TenantEntity {
  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  @ManyToOne(() => House)
  @JoinColumn({ name: 'house_id' })
  house: House;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'building_id', type: 'int' })
  buildingId: number;

  @Column({ name: 'legacy_room_key', type: 'varchar', length: 100 })
  legacyRoomKey: string;

  @Column({ name: 'address_snapshot', type: 'varchar', length: 255 })
  addressSnapshot: string;

  @Column({ name: 'project_phase', type: 'varchar', length: 20 })
  projectPhase: AccessCardProjectPhase;

  @Column({ name: 'access_system', type: 'varchar', length: 30, nullable: true })
  accessSystem: 'mjsystem' | 'iccard' | null;

  @Column({ name: 'quantity', type: 'int', default: 1 })
  quantity: number;

  @Column({ name: 'target_building_ids', type: 'jsonb', default: () => "'[]'" })
  targetBuildingIds: number[];

  @Column({ name: 'workstation_id', type: 'varchar', length: 80, nullable: true })
  workstationId: string | null;

  @Column({ type: 'varchar', length: 30, default: 'waiting_for_card' })
  status: AccessCardIssueBatchStatus;

  @Column({ name: 'current_sequence', type: 'int', default: 1 })
  currentSequence: number;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 80 })
  @Index({ unique: true })
  idempotencyKey: string;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
