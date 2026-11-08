import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 页面访问明细。created_at 由服务端按秒截断，配合唯一索引实现
 * 「同一用户 + 同一路径 + 同一秒」只记一条（页面重复挂载/组件重渲染不重复计数）。
 */
@Entity('page_views')
@Index('idx_page_views_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_page_views_tenant_user_created', ['tenantId', 'userId', 'createdAt'])
@Index('idx_page_views_tenant_path', ['tenantId', 'path'])
@Index('idx_page_views_tenant_source_created', ['tenantId', 'source', 'createdAt'])
@Index('uq_page_views_user_path_second', ['tenantId', 'userId', 'path', 'createdAt'], { unique: true })
export class PageView {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'tenant_id', type: 'int' })
  tenantId: number;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  /** 冗余姓名：用户改名后历史访问仍按当时的展示名可读 */
  @Column({ name: 'user_name', type: 'varchar', length: 60 })
  userName: string;

  @Column({ type: 'varchar', length: 300 })
  path: string;

  /** 访问来源：web / miniapp-staff / miniapp-owner；加列前的旧数据默认 web */
  @Column({ type: 'varchar', length: 20, default: 'web' })
  source: string;

  @Column({ name: 'page_key', type: 'varchar', length: 60, nullable: true })
  pageKey: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 200, nullable: true })
  userAgent: string | null;
}
