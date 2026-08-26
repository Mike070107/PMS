import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/** 物业公司（SaaS 租户） */
@Entity('tenants')
export class Tenant extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 60, nullable: true })
  contactName: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 30, nullable: true })
  contactPhone: string | null;

  // 业主端小程序 appid / 员工端小程序 appid（代申请后回填）
  @Column({ name: 'owner_appid', type: 'varchar', length: 64, nullable: true })
  ownerAppid: string | null;

  @Column({ name: 'staff_appid', type: 'varchar', length: 64, nullable: true })
  staffAppid: string | null;

  /**
   * 平台给该公司勾选的可用后台页面 key 数组（见 @pms/shared-types ADMIN_PAGES）。
   * null = 全部可用；公司内角色的权限矩阵只能在此范围内分配。
   */
  @Column({ name: 'enabled_pages', type: 'jsonb', nullable: true })
  enabledPages: string[] | null;

  /** 服务有效期（含当天）。null = 永久；过期后该公司全员请求在 JWT 层拦截 */
  @Column({ name: 'expires_at', type: 'date', nullable: true })
  expiresAt: string | null;

  /**
   * 身份角色补种完成的时间。null = 还没补过。
   *
   * 这个标记的存在意义：补种只做一次。做成每次启动都跑，企业超管之后的调整
   * （清空角色的身份、取消某个小程序入口、停用角色）会在下次重启时被悄悄回滚。
   */
  @Column({ name: 'rbac_seeded_at', type: 'timestamptz', nullable: true })
  rbacSeededAt: Date | null;

  @Column({ default: true })
  enabled: boolean;
}
