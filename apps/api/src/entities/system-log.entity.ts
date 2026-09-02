import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/**
 * 企业系统日志：登录、重要操作、客户端/API 异常和聚合告警统一落在这里。
 * tenant_id 允许为空：平台登录失败时可能还无法确定公司；企业后台查询始终按租户隔离。
 */
@Entity('system_logs')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'category', 'createdAt'])
@Index(['fingerprint', 'createdAt'])
export class SystemLog extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'int', nullable: true })
  tenantId: number | null;

  @Column({ type: 'varchar', length: 20 })
  category: 'login' | 'operation' | 'error' | 'alert' | 'usage' | 'feedback';

  @Column({ type: 'varchar', length: 12, default: 'info' })
  level: 'info' | 'warning' | 'error';

  @Column({ type: 'varchar', length: 30 })
  source: string;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ default: true })
  success: boolean;

  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId: number | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ name: 'request_method', type: 'varchar', length: 10, nullable: true })
  requestMethod: string | null;

  @Column({ name: 'request_path', type: 'varchar', length: 300, nullable: true })
  requestPath: string | null;

  @Column({ name: 'status_code', type: 'int', nullable: true })
  statusCode: number | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'varchar', length: 500 })
  message: string;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  /** 告警去重键；同一问题在冷却窗口内只通知一次。 */
  @Column({ type: 'varchar', length: 120, nullable: true })
  fingerprint: string | null;
}
