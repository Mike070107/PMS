import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type UserFeedbackKind = 'suggestion' | 'error';
export type UserFeedbackSource = 'web' | 'miniapp-staff' | 'miniapp-owner';
export type UserFeedbackStatus = 'pending' | 'handled';

/** 附件：URL 必须来自本系统 /upload/file；size 以服务端对象存储实测大小为准。 */
export type UserFeedbackAttachment = {
  url: string;
  name: string | null;
  size: number | null;
  mime: string | null;
};

export type UserFeedbackContextError = { at: string; message: string; stack?: string };

/** 提交时的环境快照：页面、UA、最近错误、版本。用于判断是否需要看报错。 */
export type UserFeedbackContext = {
  page?: string;
  userAgent?: string;
  recentErrors?: UserFeedbackContextError[];
  appVersion?: string;
};

/**
 * 「意见与建议 / 异常反馈」统一表。
 * 老字段 imageUrls/videoUrl 保留兼容员工端小程序旧版本；新客户端改用 attachments。
 */
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

  /** suggestion=意见与建议；error=异常反馈（页面报错/操作失败/数据不对） */
  @Column({ type: 'varchar', length: 20, default: 'suggestion' })
  kind: UserFeedbackKind;

  @Column({ name: 'image_urls', type: 'jsonb', default: () => "'[]'" })
  imageUrls: string[];

  @Column({ name: 'video_url', type: 'varchar', length: 1024, nullable: true })
  videoUrl: string | null;

  @Column({ name: 'video_duration_seconds', type: 'smallint', nullable: true })
  videoDurationSeconds: number | null;

  /** 统一附件列表（最多 5 个，每个 ≤20MB，URL 经 /upload/file 读取）。 */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: UserFeedbackAttachment[];

  /** 页面/UA/最近错误/版本快照，便于判断是否需要看报错。 */
  @Column({ type: 'jsonb', nullable: true })
  context: UserFeedbackContext | null;

  @Column({ type: 'varchar', length: 20, default: 'miniapp-staff' })
  source: UserFeedbackSource;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: UserFeedbackStatus;
}
