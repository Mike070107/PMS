import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/**
 * 平台操作审计：superadmin 创建/停用租户、租户切换（Login As）等敏感动作逐条落库。
 * 平台级表，不带 tenant_id（target_tenant_id 指向被操作的公司）。
 */
@Entity('platform_logs')
@Index(['actorUserId'])
@Index(['targetTenantId'])
export class PlatformLog extends BaseEntity {
  @Column({ name: 'actor_user_id', type: 'int' })
  actorUserId: number;

  /** tenant_create / tenant_update / tenant_disable / tenant_switch / admin_reset_password ... */
  @Column({ type: 'varchar', length: 40 })
  action: string;

  @Column({ name: 'target_tenant_id', type: 'int', nullable: true })
  targetTenantId: number | null;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;
}
