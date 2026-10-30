import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type MeterOcrSampleStatus = 'candidate' | 'training' | 'trained' | 'excluded';

/**
 * 识别纠错样本。
 *
 * 后台把一次读数从「识别值」改成「人工确认值」时自动落一条，保留原图、红框、
 * 方向、OCR 原文和改前/改后值。它先只是候选样本，不会立刻改线上模型；
 * 训练页可以批量标记 training / excluded，导出给离线训练和黄金集回归。
 *
 * 原图和样本不随抄表记录删除：这是后续训练与追责的唯一依据。
 */
@Entity('meter_ocr_samples')
@Index('idx_meter_ocr_samples_tenant_status', ['tenantId', 'status'])
@Index('idx_meter_ocr_samples_meter', ['tenantId', 'meterId'])
@Index('uq_meter_ocr_samples_reading', ['readingId'], { unique: true, where: 'reading_id IS NOT NULL' })
export class MeterOcrSample extends TenantEntity {
  @Column({ name: 'meter_id', type: 'int' })
  meterId: number;

  @Column({ name: 'reading_id', type: 'int', nullable: true })
  readingId: number | null;

  @Column({ name: 'meter_no_snapshot', type: 'varchar', length: 64 })
  meterNoSnapshot: string;

  @Column({ name: 'meter_type', type: 'varchar', length: 20 })
  meterType: string;

  @Column({ name: 'integer_digits', type: 'int', default: 0 })
  integerDigits: number;

  @Column({ name: 'decimal_digits', type: 'int', default: 0 })
  decimalDigits: number;

  @Column({ name: 'photo_key', type: 'varchar', length: 255, nullable: true })
  photoKey: string | null;

  @Column({ name: 'photo_url', type: 'varchar', length: 500, nullable: true })
  photoUrl: string | null;

  /** 抄表员框选的读数区域，0~1 */
  @Column({ type: 'jsonb', nullable: true })
  roi: { x: number; y: number; w: number; h: number } | null;

  @Column({ type: 'int', default: 0 })
  orientation: number;

  @Column({ name: 'ocr_provider', type: 'varchar', length: 20, nullable: true })
  ocrProvider: string | null;

  @Column({ name: 'ocr_text', type: 'text', nullable: true })
  ocrText: string | null;

  @Column({ name: 'confidence', type: 'numeric', precision: 5, scale: 2, nullable: true })
  confidence: string | null;

  @Column({ name: 'predicted_value', type: 'numeric', precision: 14, scale: 3, nullable: true })
  predictedValue: string | null;

  @Column({ name: 'predicted_digits', type: 'varchar', length: 32, nullable: true })
  predictedDigits: string | null;

  @Column({ name: 'corrected_value', type: 'numeric', precision: 14, scale: 3, nullable: true })
  correctedValue: string | null;

  @Column({ name: 'corrected_digits', type: 'varchar', length: 32, nullable: true })
  correctedDigits: string | null;

  @Column({ type: 'varchar', length: 20, default: 'candidate' })
  status: MeterOcrSampleStatus;

  /** 来源于后台复核还是现场人工改数 */
  @Column({ type: 'varchar', length: 20, default: 'review' })
  source: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'corrected_by', type: 'int', nullable: true })
  correctedBy: number | null;

  @Column({ name: 'corrected_at', type: 'timestamptz', nullable: true })
  correctedAt: Date | null;
}
