import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { FeeStandardStatus } from '../common/enums';

/**
 * 每户的收费标准：这一户、这个费用项目、每月该收多少。
 *
 * 为什么按户而不是按小区单价：老系统就是按户登记的（wydj 表），同一小区里
 * 商品房 / 售后公房 / 商铺 / 签报减免的标准各不相同，按户存才能把存量数据原样接回来。
 * 「按标准生成账单」时逐户读 active 的标准；换标准时旧的一条转 history 并落 effective_to。
 */
@Entity('fee_standards')
@Index(['tenantId', 'houseId'])
@Index(['tenantId', 'communityId', 'status'])
@Index(['tenantId', 'legacyRef'], { unique: true, where: '"legacy_ref" IS NOT NULL' })
export class FeeStandard extends TenantEntity {
  /** 房号所在小区（分期），随行落库供角色数据范围过滤 */
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  /** 费用项目 code，见 FEE_ITEMS */
  @Column({ name: 'fee_code', type: 'varchar', length: 20 })
  feeCode: string;

  /** 费用项目名称快照 */
  @Column({ name: 'fee_name', type: 'varchar', length: 40 })
  feeName: string;

  /** 每月应收（分） */
  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  /** 原始标准（分）。签报减免后 amount 低于它；没有减免时与 amount 相同或为 null */
  @Column({ name: 'standard_cents', type: 'int', nullable: true })
  standardCents: number | null;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  /** null = 一直有效到被新标准替代 */
  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({ type: 'varchar', length: 20, default: FeeStandardStatus.ACTIVE })
  status: FeeStandardStatus;

  /** 调价依据（签报文号等） */
  @Column({ name: 'doc_no', type: 'varchar', length: 60, nullable: true })
  docNo: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  /** 导入来源标识（wjwy:dj:<wydj.ID>），重跑导入时按它去重 */
  @Column({ name: 'legacy_ref', type: 'varchar', length: 60, nullable: true })
  legacyRef: string | null;
}
