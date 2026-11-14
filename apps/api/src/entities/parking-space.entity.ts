import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 车位类别：产权 / 租赁 / 空置；NULL = 未登记（旧数据不回填推断）。 */
export const PARKING_SPACE_CATEGORIES = ['property', 'rental', 'vacant'] as const;
export type ParkingSpaceCategory = (typeof PARKING_SPACE_CATEGORIES)[number];

/**
 * 车位档案：大车库 / 二期人防车库的车位清单。
 *
 * 为什么单独一张表：这两个车库是按「车位」管理（谁买了/租了哪个位），
 * 不是按车牌——大车库有 182 个位、人防 94 个位，车牌是老系统里后补的。
 * 车位号在各自车库内唯一（unique(garage, space_no)）。
 */
@Entity('parking_spaces')
@Index(['garage', 'spaceNo'], { unique: true })
export class ParkingSpace extends TenantEntity {
  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  /** main = 二期大车库，civil = 二期人防车库 */
  @Column({ type: 'varchar', length: 20 })
  garage: 'main' | 'civil';

  @Column({ name: 'space_no', type: 'varchar', length: 20 })
  spaceNo: string;

  @Column({ name: 'house_no', type: 'varchar', length: 60, nullable: true })
  houseNo: string | null;

  @Column({ name: 'area_sqm', type: 'numeric', precision: 7, scale: 2, nullable: true })
  areaSqm: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  plate: string | null;

  @Column({ name: 'owner_name', type: 'varchar', length: 60, nullable: true })
  ownerName: string | null;

  @Column({ name: 'owner_tel', type: 'varchar', length: 30, nullable: true })
  ownerTel: string | null;

  /** 独立车位类别；新增默认产权。改类别不解绑车辆、不清备注/来源/车牌。 */
  @Column({ type: 'varchar', length: 20, nullable: true, default: 'property' })
  category: ParkingSpaceCategory | null;

  /** 产权 / 租赁车位 / 公司 … */
  /** 车牌续费有效期（旧停车系统的 End_Time） */
  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  source: string | null;
}
