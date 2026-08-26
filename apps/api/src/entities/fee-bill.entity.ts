import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { FeeBillSource, FeeBillStatus } from '../common/enums';

/**
 * 物业费账单：一户、一个费用项目、一个账期（月）一条。
 *
 * 只做记账：登记收款 / 撤销收款 / 作废，不接在线支付。
 * 老系统的 wyzj 表就是这个粒度（每户每月一行，收款日期为空即欠费），
 * 导入时一行对一行，legacy_ref 保证重跑不建重。
 */
@Entity('fee_bills')
@Index(['tenantId', 'houseId', 'period'])
@Index(['tenantId', 'communityId', 'period'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'legacyRef'], { unique: true, where: '"legacy_ref" IS NOT NULL' })
export class FeeBill extends TenantEntity {
  /** 房号所在小区（分期），随单落库供角色数据范围过滤 */
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  /** 出账时绑定在该房号上的业主；导入的历史账单可能没有对应档案 */
  @Column({ name: 'owner_id', type: 'int', nullable: true })
  ownerId: number | null;

  /** 缴费人姓名快照：业主换了，历史账单上还是当年那个人 */
  @Column({ name: 'owner_name', type: 'varchar', length: 60, nullable: true })
  ownerName: string | null;

  @Column({ name: 'fee_code', type: 'varchar', length: 20 })
  feeCode: string;

  @Column({ name: 'fee_name', type: 'varchar', length: 40 })
  feeName: string;

  /** 账期，YYYYMM */
  @Column({ type: 'varchar', length: 6 })
  period: string;

  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  @Column({ type: 'varchar', length: 20, default: FeeBillStatus.UNPAID })
  status: FeeBillStatus;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** cash / wechat / alipay / bank / cheque / other */
  @Column({ name: 'payment_method', type: 'varchar', length: 30, nullable: true })
  paymentMethod: string | null;

  /** 收据号。一次收几个月的账单共用同一个收据号（老系统的「合并单据号」也落这里） */
  @Column({ name: 'receipt_no', type: 'varchar', length: 60, nullable: true })
  receiptNo: string | null;

  @Column({ name: 'invoice_no', type: 'varchar', length: 60, nullable: true })
  invoiceNo: string | null;

  /** 收款人（老系统里是自由文本；本系统登记收款时记操作人姓名） */
  @Column({ type: 'varchar', length: 60, nullable: true })
  cashier: string | null;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  @Column({ type: 'varchar', length: 20, default: FeeBillSource.MANUAL })
  source: FeeBillSource;

  /** 由哪条收费标准生成（导入 / 手工录入的为 null） */
  @Column({ name: 'standard_id', type: 'int', nullable: true })
  standardId: number | null;

  /** 导入来源标识（wjwy:zj:<wyzj.ZJ_ID>），重跑导入时按它去重 */
  @Column({ name: 'legacy_ref', type: 'varchar', length: 60, nullable: true })
  legacyRef: string | null;
}
