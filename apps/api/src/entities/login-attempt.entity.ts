import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 登录尝试（成功与失败都记）。现有 system_logs 仍保留通用登录审计；
 * 本表用于结构化查询失败原因/脱敏账号/方式，避免把密码或全量账号写进日志。
 */
@Entity('login_attempts')
@Index('idx_login_attempts_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_login_attempts_tenant_status_created', ['tenantId', 'status', 'createdAt'])
export class LoginAttempt {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'tenant_id', type: 'int', nullable: true })
  tenantId: number | null;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'user_name', type: 'varchar', length: 60, nullable: true })
  userName: string | null;

  /** 脱敏后的尝试账号，不落明文全量账号 */
  @Column({ name: 'account_masked', type: 'varchar', length: 80, nullable: true })
  accountMasked: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 200, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 10 })
  method: 'password' | 'wechat';

  @Column({ type: 'varchar', length: 10 })
  status: 'success' | 'failed';

  @Column({ type: 'varchar', length: 40, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  message: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
