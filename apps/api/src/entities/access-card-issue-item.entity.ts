import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { AccessCardIssueBatch } from './access-card-issue-batch.entity';

export type AccessCardWriteStatus =
  | 'waiting_for_card'
  | 'reader_detected'
  | 'uid_read'
  | 'authorization_verified'
  | 'writing'
  | 'readback_verified'
  | 'card_completed';
export type AccessCardActivationStatus =
  | 'not_required'
  | 'pending'
  | 'access_db_written'
  | 'controller_uploading'
  | 'controller_uploaded'
  | 'waiting_retry'
  | 'needs_operator';
export type AccessCardLegacySyncStatus =
  | 'pending'
  | 'person_created'
  | 'card_record_created'
  | 'synced'
  | 'waiting_retry'
  | 'conflict';

/** 批次中的一张实体卡；三个状态轴避免把“写好卡”误当成“控制器已生效”。 */
@Entity('access_card_issue_items')
@Index(['batchId', 'sequence'], { unique: true })
@Index(['tenantId', 'icCardNo'], { unique: true })
@Index(['tenantId', 'wgCardNo'], { unique: true })
export class AccessCardIssueItem extends TenantEntity {
  @Column({ name: 'batch_id', type: 'int' })
  batchId: number;

  @ManyToOne(() => AccessCardIssueBatch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch: AccessCardIssueBatch;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ name: 'card_status', type: 'varchar', length: 40, default: 'waiting_for_card' })
  cardStatus: AccessCardWriteStatus;

  @Column({ name: 'access_status', type: 'varchar', length: 40 })
  accessStatus: AccessCardActivationStatus;

  @Column({ name: 'legacy_sync_status', type: 'varchar', length: 40, default: 'pending' })
  legacySyncStatus: AccessCardLegacySyncStatus;

  @Column({ name: 'ic_card_no', type: 'varchar', length: 40, nullable: true })
  icCardNo: string | null;

  @Column({ name: 'wg_card_no', type: 'varchar', length: 20, nullable: true })
  wgCardNo: string | null;

  @Column({ name: 'legacy_person_id', type: 'int', nullable: true })
  legacyPersonId: number | null;

  @Column({ name: 'legacy_person_no', type: 'varchar', length: 40, nullable: true })
  legacyPersonNo: string | null;

  @Column({ name: 'legacy_house_sequence', type: 'int', nullable: true })
  legacyHouseSequence: number | null;

  @Column({ name: 'controller_results', type: 'jsonb', default: () => "'[]'" })
  controllerResults: Array<Record<string, unknown>>;

  @Column({ name: 'last_error_ref', type: 'varchar', length: 20, nullable: true })
  lastErrorRef: string | null;

  @Column({ name: 'last_error_message', type: 'varchar', length: 500, nullable: true })
  lastErrorMessage: string | null;

  @Column({ name: 'lease_agent_key', type: 'varchar', length: 80, nullable: true })
  leaseAgentKey: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'card_completed_at', type: 'timestamptz', nullable: true })
  cardCompletedAt: Date | null;

  @Column({ name: 'access_completed_at', type: 'timestamptz', nullable: true })
  accessCompletedAt: Date | null;

  @Column({ name: 'legacy_synced_at', type: 'timestamptz', nullable: true })
  legacySyncedAt: Date | null;
}
