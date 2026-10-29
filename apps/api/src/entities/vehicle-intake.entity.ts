import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 车牌办理单：前台在收银台给一户「新办车牌」时生成，业主手机扫码自己填车牌、车主电话并上传资料。
 *
 * - paid   = 付费新车：钱可以先收（流水挂「待业主资料」），资料审核通过后进入执行；
 * - family = 亲情车：不收费，资料审核通过后转成亲情车登记（family_cars），走原有的经理审核与开通。
 *
 * 二维码默认 1 小时有效，可重新生成（旧码立即失效）；业主可以拍下二维码回家再填。
 */
export type VehicleIntakeKind = 'paid' | 'family';
export type VehicleIntakeStatus =
  | 'waiting' //  等业主扫码填写
  | 'submitted' // 业主已提交，待办公室审核资料
  | 'reupload' //  办公室退回，等业主重新上传
  | 'approved' //  资料已通过（付费车：等收费 / 已进入执行；亲情车：已转亲情车登记）
  | 'void'; //      已作废

export interface VehicleIntakeFile {
  objectKey: string;
  fileName: string;
  contentType: string;
  uploadedAt: string;
}

export interface VehicleIntakeLog {
  at: string;
  userId: number | null;
  userName: string;
  action: string;
  note?: string;
}

@Entity('vehicle_intakes')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'houseId'])
@Index(['tokenHash'])
export class VehicleIntake extends TenantEntity {
  @Column({ type: 'varchar', length: 10 })
  kind: VehicleIntakeKind;

  @Column({ type: 'varchar', length: 12, default: 'waiting' })
  status: VehicleIntakeStatus;

  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  /** 显示用：枫桦景苑二期/228弄3号502 */
  @Column({ name: 'house_label', type: 'varchar', length: 120, default: '' })
  houseLabel: string;

  @Column({ name: 'owner_name', type: 'varchar', length: 50, default: '' })
  ownerName: string;

  @Column({ name: 'owner_phone', type: 'varchar', length: 30, default: '' })
  ownerPhone: string;

  /** 业主扫码填写（办公室审核时可更正） */
  @Column({ type: 'varchar', length: 10, default: '' })
  plate: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 50, default: '' })
  contactName: string;

  @Column({ name: 'contact_phone', type: 'varchar', length: 30, default: '' })
  contactPhone: string;

  /** 付费车：按哪类收费（业主车 / 租客车 / 大车…），新办时先选 */
  @Column({ name: 'vehicle_class', type: 'varchar', length: 12, default: '' })
  vehicleClass: string;

  /** 亲情车：与业主关系 */
  @Column({ type: 'varchar', length: 20, default: '' })
  relation: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  files: VehicleIntakeFile[];

  /** 要开通的车库：付费车存停车目标 key；亲情车存 phase1/phase2/main/civil */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  garages: string[];

  @Column({ name: 'garage_numbers', type: 'jsonb', default: () => "'{}'::jsonb" })
  garageNumbers: Record<string, string>;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  /**
   * 二维码随机种子：链接里的码 = HMAC(服务端密钥, 种子)，库里只存种子和码的哈希。
   * 办公室刷新页面后可以按种子再显示同一个码（没过期就一直有效），不必换码让业主拍过的码作废。
   */
  @Column({ name: 'token_nonce', type: 'varchar', length: 32, default: '' })
  tokenNonce: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy: number | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'review_note', type: 'varchar', length: 500, default: '' })
  reviewNote: string;

  /** 付费车：收款流水（business_transactions.id） */
  @Column({ name: 'transaction_id', type: 'int', nullable: true })
  transactionId: number | null;

  /** 亲情车：审核通过后生成的亲情车登记 */
  @Column({ name: 'family_car_id', type: 'int', nullable: true })
  familyCarId: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  log: VehicleIntakeLog[];
}
