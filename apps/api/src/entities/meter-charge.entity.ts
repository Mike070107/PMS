import { Column, Entity, Index, JoinColumn, OneToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { MeterReading } from './meter-reading.entity';

export type MeterChargeStatus = 'unpaid' | 'partial' | 'paid' | 'void';

/**
 * 抄表产生的应收账单（记账）。
 *
 * 金额全部用「分」存整数：0.65 元/度 × 153.2 度这种乘法用浮点会出现 99.5800000001，
 * 对账时差一分钱也要查半天。用量保留三位小数，金额四舍五入到分。
 *
 * 一条抄表记录最多对应一张账单（reading_id 唯一）。调价、补录、作废都改这张单，
 * 不另建一张负单 —— 项目现有的收费红冲体系在 fee_bills，不在这里混用。
 */
@Entity('meter_charges')
@Index('idx_meter_charges_meter_period', ['tenantId', 'meterId', 'period'])
@Index('idx_meter_charges_tenant_status', ['tenantId', 'status'])
@Index('uq_meter_charges_reading', ['readingId'], { unique: true })
export class MeterCharge extends TenantEntity {
  @Column({ name: 'meter_id', type: 'int' })
  meterId: number;

  @Column({ name: 'reading_id', type: 'int' })
  readingId: number;

  @OneToOne(() => MeterReading)
  @JoinColumn({ name: 'reading_id' })
  reading: MeterReading;

  @Column({ name: 'meter_no_snapshot', type: 'varchar', length: 64 })
  meterNoSnapshot: string;

  @Column({ name: 'owner_name_snapshot', type: 'varchar', length: 60, nullable: true })
  ownerNameSnapshot: string | null;

  /** 账期 YYYY-MM，按抄表时间（北京时间）归月 */
  @Column({ type: 'varchar', length: 7 })
  period: string;

  @Column({ name: 'usage_value', type: 'numeric', precision: 14, scale: 3 })
  usageValue: string;

  /** 单价快照，分/单位；以后调价不影响已出账单 */
  @Column({ name: 'unit_price_cents', type: 'int' })
  unitPriceCents: number;

  /** 应收 = 用量 × 单价 + 调整 */
  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  /** 人工调整（减免为负、补收为正），必须写备注 */
  @Column({ name: 'adjustment_cents', type: 'int', default: 0 })
  adjustmentCents: number;

  @Column({ name: 'receivable_cents', type: 'int' })
  receivableCents: number;

  @Column({ name: 'paid_cents', type: 'int', default: 0 })
  paidCents: number;

  @Column({ type: 'varchar', length: 20, default: 'unpaid' })
  status: MeterChargeStatus;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'payment_method', type: 'varchar', length: 30, nullable: true })
  paymentMethod: string | null;

  @Column({ name: 'receipt_no', type: 'varchar', length: 60, nullable: true })
  receiptNo: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
