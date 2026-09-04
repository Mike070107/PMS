import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 谁收藏了哪篇维修经验。
 * 小程序列表默认只展开收藏的那几篇，其余笔记本收起（2026-09-04 反馈：列表太长看不过来）。
 * 一人一篇一行；取消收藏就删行，不留软删除。
 */
@Entity('repair_experience_favorites')
@Index(['tenantId', 'userId', 'noteId'], { unique: true })
export class RepairExperienceFavorite extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'note_id', type: 'int' })
  noteId: number;
}
