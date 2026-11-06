import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 住宅催缴短信逐条发送记录。
 *
 * 批次快照里只有脱敏号码，所以这里只存尾号：既能对上人，又不把明文号码落库。
 * 状态由发送结果与运营商回执共同推进：submitted → delivered / failed。
 */
@Entity('mis_collection_sms')
@Index('idx_mis_sms_batch', ['tenantId', 'batchId'])
@Index('idx_mis_sms_biz', ['tenantId', 'bizId'])
export class MisCollectionSms extends TenantEntity {
  @Column({ name: 'batch_id', type: 'int' })
  batchId: number;

  /** MIS 责任对象键：0x:ownerId:houseId */
  @Column({ name: 'house_key', type: 'varchar', length: 64 })
  houseKey: string;

  /** 号码后四位，够人工核对，不落明文 */
  @Column({ name: 'phone_tail', type: 'varchar', length: 8 })
  phoneTail: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 12, default: 'queued' })
  status: 'queued' | 'submitted' | 'delivered' | 'failed';

  @Column({ name: 'biz_id', type: 'varchar', length: 80, nullable: true })
  bizId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  error: string | null;

  @Column({ name: 'segment_count', type: 'int', default: 1 })
  segmentCount: number;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
