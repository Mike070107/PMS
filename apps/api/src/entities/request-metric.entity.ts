import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/** 轻量请求指标，保留 30 天，用于访问量、错误率、响应时间与各端负载分析。 */
@Entity('request_metrics')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'source', 'createdAt'])
export class RequestMetric extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'int', nullable: true })
  tenantId: number | null;

  @Column({ type: 'varchar', length: 30 })
  source: string;

  @Column({ type: 'varchar', length: 10 })
  method: string;

  @Column({ type: 'varchar', length: 240 })
  path: string;

  @Column({ name: 'status_code', type: 'int' })
  statusCode: number;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId: number | null;
}
