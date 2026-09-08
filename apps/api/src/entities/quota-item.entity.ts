import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 预算定额条目：养护单上「预算定额（编号 / 工时 / 人工费）」那三格的来源。
 *
 * 人工费不存在这里 —— 它是 `工时 × 数量 × 定额人工单价` 算出来的，
 * 单价涨了只改一处（tenant_configs.quota_params.laborRateCents），
 * 不用把几百条定额逐条改一遍。
 */
/**
 * 唯一键是 编号 + 项目 + 规格，**不是编号**：真实的定额本里一个号能挂好几个项目
 * （012-219 是「其它零星」的兜底号，下面 11 个项目工时各不相同；
 * 16-2-20/21/22/24「拆装污水管」按管径 50/75/110/160 分成四条）。
 * 2026-09-08 按吴泾在用的那本定额补齐种子数据时发现，原来的 (tenantId, code) 唯一约束存不进去。
 */
@Entity('quota_items')
@Index(['tenantId'])
@Index(['tenantId', 'code'])
@Index(['tenantId', 'code', 'name', 'spec'], { unique: true })
export class QuotaItem extends TenantEntity {
  /** 定额编号，如 15-4-17 */
  @Column({ type: 'varchar', length: 40 })
  code: string;

  /** 项目名称，如 修换声控灯 */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * 规格：管径 50 / 25mm / 4" 这类。空串表示不分规格 ——
   * 用空串不用 null，否则唯一索引对 NULL 不去重，同名同号的会被重复种进去。
   */
  @Column({ type: 'varchar', length: 60, default: '' })
  spec: string;

  /** 计量单位，如 只 / m² */
  @Column({ type: 'varchar', length: 20, default: '项' })
  unit: string;

  /** 每单位工时定额 */
  @Column({ type: 'numeric', precision: 10, scale: 3, default: 0 })
  hours: string;

  /** 参考材料费（分/单位）；填了新建明细行时带出来，可改 */
  @Column({ name: 'material_fee_cents', type: 'int', default: 0 })
  materialFeeCents: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
