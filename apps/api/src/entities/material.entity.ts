import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 材料 SKU */
@Entity('materials')
@Index(['tenantId'])
@Index(['tenantId', 'code'], { unique: true })
export class Material extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  spec: string | null;

  // 材料分类编码（dict type=material_category）
  @Column({ type: 'varchar', length: 60, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 20, default: '个' })
  unit: string;

  // 参考成本（分）= 全公司剩余批次的移动加权均价，入库 / 盘盈后由 stock-ledger 自动刷新。
  // 只用于展示、盘盈默认单价、没批次的老库存兜底；出库成本取批次单价，不用它
  @Column({ name: 'default_cost_cents', type: 'int', default: 0 })
  defaultCostCents: number;

  // 第一张实物照片。列表 / 选料弹层 / 工单里只要一张缩略图的地方全读它，
  // 写入时由服务端从 photoUrls[0] 同步，别单独改这一个字段
  @Column({ name: 'photo_url', type: 'varchar', length: 500, nullable: true })
  photoUrl: string | null;

  // 实物照片全集（最多 4 张）：正面 / 侧面 / 铭牌 / 包装，维修工靠它比对认货
  @Column({ name: 'photo_urls', type: 'jsonb', default: () => "'[]'" })
  photoUrls: string[];

  // 别名（同物异名：胶带/胶布），搜索时与名称一起匹配
  @Column({ type: 'jsonb', default: () => "'[]'" })
  aliases: string[];

  // 详细参数（自由文本：材质/尺寸/技术参数等）
  @Column({ type: 'text', nullable: true })
  params: string | null;

  @Column({ default: true })
  enabled: boolean;
}
