import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Meter } from './meter.entity';

export type MeterReadingSource = 'photo' | 'manual' | 'import';
export type MeterReadingStatus = 'confirmed' | 'void';
export type MeterOcrStatus = 'success' | 'failed' | 'skipped';

/** 异常标记只用于提醒人复核，不阻断保存：现场情况千差万别，拦下来只会逼人改数 */
export type MeterReadingAnomaly =
  | 'low_confidence'
  | 'meter_no_mismatch'
  | 'rollover'
  | 'zero_usage'
  | 'high_usage'
  | 'backdated'
  | 'no_location'
  | 'photo_missing';

export interface MeterOcrResult {
  provider: 'sidecar' | 'llm' | 'none';
  value: number | null;
  digits: string | null;
  confidence: number;
  meterNo: string | null;
  meterNoCandidates: string[];
  rawText: string;
  texts: Array<{ text: string; score: number; box?: number[] }>;
  needsReview: boolean;
  error?: string;
}

/**
 * 一次抄表。原图、识别结果、人工确认值三样同时保留：
 * 原图是事后纠纷时唯一能回看的证据，OCR 原文用于持续调模型，确认值才是账。
 */
@Entity('meter_readings')
@Index('idx_meter_readings_meter_time', ['tenantId', 'meterId', 'readAt'])
@Index('idx_meter_readings_tenant_time', ['tenantId', 'readAt'])
@Index('idx_meter_readings_status', ['tenantId', 'status'])
@Index('uq_meter_readings_client', ['tenantId', 'clientRequestId'], {
  unique: true,
  where: 'client_request_id IS NOT NULL',
})
export class MeterReading extends TenantEntity {
  @Column({ name: 'meter_id', type: 'int' })
  meterId: number;

  @ManyToOne(() => Meter)
  @JoinColumn({ name: 'meter_id' })
  meter: Meter;

  /** 抄表当时的表号快照：表号后来改过，历史记录仍应显示当时那块表 */
  @Column({ name: 'meter_no_snapshot', type: 'varchar', length: 64 })
  meterNoSnapshot: string;

  @Column({ name: 'reading_value', type: 'numeric', precision: 14, scale: 3 })
  readingValue: string;

  @Column({ name: 'previous_value', type: 'numeric', precision: 14, scale: 3, nullable: true })
  previousValue: string | null;

  /** 用量 = (本次 - 上次) × 倍率；第一次抄表且没有底数时为 null */
  @Column({ name: 'usage_value', type: 'numeric', precision: 14, scale: 3, nullable: true })
  usageValue: string | null;

  /** 拍照/抄表发生时间（端上时钟），不是入库时间 */
  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt: Date;

  @Column({ type: 'varchar', length: 20, default: 'photo' })
  source: MeterReadingSource;

  @Column({ name: 'photo_key', type: 'varchar', length: 255, nullable: true })
  photoKey: string | null;

  @Column({ name: 'photo_url', type: 'varchar', length: 500, nullable: true })
  photoUrl: string | null;

  @Column({ name: 'photo_width', type: 'int', nullable: true })
  photoWidth: number | null;

  @Column({ name: 'photo_height', type: 'int', nullable: true })
  photoHeight: number | null;

  /** 端上框选的读数区域（0~1 归一化），便于复现 OCR 与后续训练 */
  @Column({ type: 'jsonb', nullable: true })
  roi: { x: number; y: number; w: number; h: number } | null;

  @Column({ name: 'ocr_status', type: 'varchar', length: 20, default: 'skipped' })
  ocrStatus: MeterOcrStatus;

  @Column({ name: 'ocr_provider', type: 'varchar', length: 20, nullable: true })
  ocrProvider: string | null;

  @Column({ name: 'ocr_confidence', type: 'numeric', precision: 5, scale: 2, nullable: true })
  ocrConfidence: string | null;

  @Column({ name: 'ocr_text', type: 'text', nullable: true })
  ocrText: string | null;

  @Column({ name: 'ocr_meter_no', type: 'varchar', length: 64, nullable: true })
  ocrMeterNo: string | null;

  @Column({ name: 'ocr_raw', type: 'jsonb', nullable: true })
  ocrRaw: Record<string, unknown> | null;

  /** OCR 时自动选定的旋转角（0/90/180/270），原图不旋转，只用于审计与复现 */
  @Column({ type: 'int', default: 0 })
  orientation: number;

  @Column({ type: 'varchar', length: 20, default: 'confirmed' })
  status: MeterReadingStatus;

  @Column({ name: 'anomaly_flags', type: 'jsonb', default: () => "'[]'::jsonb" })
  anomalyFlags: MeterReadingAnomaly[];

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  latitude: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  longitude: string | null;

  @Column({ name: 'gps_accuracy', type: 'numeric', precision: 8, scale: 2, nullable: true })
  gpsAccuracy: string | null;

  @Column({ name: 'operator_id', type: 'int', nullable: true })
  operatorId: number | null;

  @Column({ name: 'operator_name', type: 'varchar', length: 60, nullable: true })
  operatorName: string | null;

  /** 客户端的幂等键：地下车库没信号，重试一次不该多出一条记录 */
  @Column({ name: 'client_request_id', type: 'varchar', length: 64, nullable: true })
  clientRequestId: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy: number | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote: string | null;
}
