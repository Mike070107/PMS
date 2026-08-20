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

  // 该楼栋归属的责任片区编码（派单匹配用）
  @Column({ type: 'varchar', length: 60, nullable: true })
  zone: string | null;
}
