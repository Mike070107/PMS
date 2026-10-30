import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Community } from './community.entity';
import { House } from './house.entity';

/** 目前现场会遇到的四类表；新类型只影响展示和默认单位，不另建表 */
export type MeterType = 'water' | 'electricity' | 'gas' | 'heat';

export type MeterStatus = 'active' | 'disabled';

/**
 * 仪表档案。
 *
 * 一个「表」不是房产的附属字段：同一户可能有一块水表、一块电表，公共区域还有总表；
 * 水表可能装在楼道井里、电表装在集中表箱里，位置和住户地址并不相同。所以单独建档，
 * 位置、使用人、单价都记在表上，抄表记录只引用表。
 *
 * `integerDigits` / `decimalDigits` 是识别读数能否正确的关键：电表液晶屏常显示
 * 6 位整数 + 2 位小数（022418.88），照片 OCR 往往把小数点吞掉，只认出 02241888；
 * 水表机械字轮则通常 5 位整数、无小数（02405）。建档时定好位数，服务端按位补小数点，
 * 不靠模型猜。
 */
@Entity('meters')
@Index('idx_meters_tenant_type', ['tenantId', 'meterType'])
@Index('idx_meters_tenant_community', ['tenantId', 'communityId'])
@Index('uq_meters_tenant_no', ['tenantId', 'meterType', 'meterNo'], { unique: true })
@Index('uq_meters_qr_token', ['qrToken'], { unique: true })
export class Meter extends TenantEntity {
  /** 表身钢印号 / 出厂编号 / 电表条码号，不是户号 */
  @Column({ name: 'meter_no', type: 'varchar', length: 64 })
  meterNo: string;

  @Column({ name: 'meter_type', type: 'varchar', length: 20 })
  meterType: MeterType;

  /** 便于现场识别的名字，如「1号楼1单元总表」「301室电表」 */
  @Column({ type: 'varchar', length: 120, nullable: true })
  name: string | null;

  /** 口径/规格：DN20、3×220/380V 1.5(6)A 等 */
  @Column({ type: 'varchar', length: 120, nullable: true })
  spec: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  manufacturer: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  model: string | null;

  /**
   * 倍率：经互感器的电表、部分大口径水表读数要乘它才是实际用量。
   * 默认 1；大于 1 时页面会显示「读数 × 倍率」。
   */
  @Column({ type: 'numeric', precision: 10, scale: 3, default: 1 })
  multiplier: string;

  @Column({ name: 'integer_digits', type: 'int', default: 6 })
  integerDigits: number;

  @Column({ name: 'decimal_digits', type: 'int', default: 0 })
  decimalDigits: number;

  /** 展示单位：m³ / kWh / m³(气) / GJ */
  @Column({ type: 'varchar', length: 20, default: 'm³' })
  unit: string;

  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  @ManyToOne(() => Community, { nullable: true })
  @JoinColumn({ name: 'community_id' })
  community: Community | null;

  /** 关联到具体房号；公共区域总表可以留空 */
  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  @ManyToOne(() => House, { nullable: true })
  @JoinColumn({ name: 'house_id' })
  house: House | null;

  /** 安装地点：楼道水表井、负一层电表箱 3 号柜… */
  @Column({ name: 'install_address', type: 'varchar', length: 255, nullable: true })
  installAddress: string | null;

  /** GPS 用于导航和「到表附近才能抄」的后续扩展；现场无信号时允许为空 */
  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  latitude: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 7, nullable: true })
  longitude: string | null;

  @Column({ name: 'owner_name', type: 'varchar', length: 60, nullable: true })
  ownerName: string | null;

  @Column({ name: 'owner_phone', type: 'varchar', length: 30, nullable: true })
  ownerPhone: string | null;

  /** 单价，分/计量单位。水 4.2 元/m³ 存 420；电 0.65 元/kWh 存 65 */
  @Column({ name: 'unit_price_cents', type: 'int', default: 0 })
  unitPriceCents: number;

  /** 关掉后仍可抄表留痕，只是不自动生成应收账单（如内部考核表） */
  @Column({ name: 'billing_enabled', type: 'boolean', default: true })
  billingEnabled: boolean;

  /** 建档底数。第一次抄表用它算用量；没填则第一次只记读数、不算用量 */
  @Column({ name: 'initial_reading', type: 'numeric', precision: 14, scale: 3, nullable: true })
  initialReading: string | null;

  @Column({ name: 'initial_reading_at', type: 'timestamptz', nullable: true })
  initialReadingAt: Date | null;

  /** 最近一次确认读数，列表和「上次读数」直接用，避免每行再子查询 */
  @Column({ name: 'last_reading_value', type: 'numeric', precision: 14, scale: 3, nullable: true })
  lastReadingValue: string | null;

  @Column({ name: 'last_reading_at', type: 'timestamptz', nullable: true })
  lastReadingAt: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: MeterStatus;

  /** 表身二维码内容，扫码直达这块表；不随 id 变化，换标签不用改库 */
  @Column({ name: 'qr_token', type: 'varchar', length: 64 })
  qrToken: string;

  @Column({ name: 'photo_key', type: 'varchar', length: 255, nullable: true })
  photoKey: string | null;

  @Column({ name: 'photo_url', type: 'varchar', length: 500, nullable: true })
  photoUrl: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'text', nullable: true })
  remark: string | null;
}
