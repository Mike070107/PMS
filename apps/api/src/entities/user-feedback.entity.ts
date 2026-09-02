import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 员工小程序「我的 → 意见与建议」提交的产品反馈。 */
@Entity('user_feedback')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'userId'])
export class UserFeedback extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  /** 姓名、电话按提交当时快照，账号以后改名或停用也能找到反馈人。 */
  @Column({ name: 'user_name', type: 'varchar', length: 60, nullable: true })
  userName: string | null;

  @Column({ name: 'user_phone', type: 'varchar', length: 30, nullable: true })
  userPhone: string | null;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'image_urls', type: 'jsonb', default: () => "'[]'" })
  imageUrls: string[];

  @Column({ name: 'video_url', type: 'varchar', length: 1024, nullable: true })
  videoUrl: string | null;

  @Column({ name: 'video_duration_seconds', type: 'smallint', nullable: true })
  videoDurationSeconds: number | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: 'pending' | 'handled';
}
