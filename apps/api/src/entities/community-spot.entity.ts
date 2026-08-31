import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Community } from './community.entity';
import { Building } from './building.entity';

/**
 * 公区点位：监控室、门卫室、水泵房、电梯机房、垃圾房……
 *
 * 为什么单开一张表，而不是在 houses 里加一条「商铺」：
 * 这些地方没有业主、没有面积、不收物业费，塞进房产台账会把统计和收费口径弄脏；
 * 而且报修地址识别找房号只按数字撞（sameNo(roomNo)），名字叫「监控室」的房号永远撞不上。
 * 单开一张表之后，「监控室2号显示屏不亮」就能按名字认到点位，落成
 * 「枫桦景苑二期 监控室」的公区单，而不是错挂到 228弄2号楼上。
 *
 * 默认挂在小区级；buildingId 有值表示这个点位在某一栋楼里（「3号楼电梯机房」），
 * 识别时地址会精确到那栋楼，维修工少绕一趟。
 */
@Entity('community_spots')
@Index(['tenantId', 'communityId'])
export class CommunitySpot extends TenantEntity {
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @ManyToOne(() => Community)
  @JoinColumn({ name: 'community_id' })
  community: Community;

  /** 点位所在楼栋。null = 整个小区的公共点位 */
  @Column({ name: 'building_id', type: 'int', nullable: true })
  buildingId: number | null;

  @ManyToOne(() => Building, { nullable: true })
  @JoinColumn({ name: 'building_id' })
  building: Building | null;

  /** 点位名称，报修描述里出现这个词就按它定位，所以别起「1号」这种纯数字名 */
  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ default: true })
  enabled: boolean;
}
