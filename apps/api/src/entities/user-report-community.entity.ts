import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 代报授权：保安/居委会/业委会 能报修哪些小区。
 *
 * 逐条授权而不是一个「可代报」开关：物业公司常管十几个小区，
 * 一个保安只该报他值班的那一两个，不能顺手给任意小区提单。
 * 一个人管两个小区就是两条记录。
 */
@Entity('user_report_communities')
@Index(['tenantId', 'userId'])
@Index(['userId', 'communityId'], { unique: true })
export class UserReportCommunity extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;
}
