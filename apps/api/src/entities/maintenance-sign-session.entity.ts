import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 养护单的一次性移动签名会话。
 *
 * JWT 只负责证明链接没有被伪造；这张表负责“一次性”和跨进程状态。
 * 如果只靠内存，API 重启或多实例部署后，同一二维码可能再次提交。
 */
@Entity('maintenance_sign_sessions')
@Index(['tenantId', 'maintenanceOrderId'])
@Index(['expiresAt'])
export class MaintenanceSignSession extends TenantEntity {
  @Column({ name: 'maintenance_order_id', type: 'int' })
  maintenanceOrderId: number;

  @Column({ type: 'varchar', length: 20 })
  slot: string;

  @Column({ name: 'requested_by', type: 'int' })
  requestedBy: number;

  @Column({ name: 'signer_name', type: 'varchar', length: 60, nullable: true })
  signerName: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;
}
