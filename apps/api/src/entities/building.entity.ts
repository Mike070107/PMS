import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Community } from './community.entity';

/**
 * 楼栋。中文场景里"弄"在这一层表达：
 * - lane（弄）+ buildingNo（号）共同定位一栋楼
 */
@Entity('buildings')
@Index(['tenantId', 'communityId'])
export class Building extends TenantEntity {
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @ManyToOne(() => Community)
  @JoinColumn({ name: 'community_id' })
  community: Community;

  @Column({ type: 'varchar', length: 30, nullable: true })
  lane: string | null; // 弄

  @Column({ name: 'building_no', type: 'varchar', length: 30 })
  buildingNo: string; // 号

  /**
   * 路名（宝秀路、剑川路）。**路名是楼栋的属性，不是每户的**——
   * 原来只存在 houses 上，楼栋级地址（公区报修、只说到楼栋的工单）就永远显示不出路名：
   * 办公楼「宝秀路858号」在界面上只剩「858号」（2026-09-15 Mike 点名）。
   *
   * 有弄的小区不显示它（「198弄24号」已经够定位，见 address-line.util 的规则），
   * 没有弄的（办公楼、沿街商铺）才靠它说清楚在哪条路上。
   */
  @Column({ name: 'road_name', type: 'varchar', length: 60, nullable: true })
  roadName: string | null;

  // 该楼栋归属的责任片区编码（派单匹配用）
  @Column({ type: 'varchar', length: 60, nullable: true })
  zone: string | null;
}
