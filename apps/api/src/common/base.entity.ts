import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Column,
} from 'typeorm';

/**
 * 所有业务表共享的基础列。
 * - id：自增主键
 * - created_at / updated_at：timestamptz，保证跨时区绝对时刻正确
 * - created_by / updated_by：操作人 user id（可空，系统操作时为 null）
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;
}

/**
 * 多租户业务表基类：在 BaseEntity 之上加 tenant_id 行级隔离列。
 * 平台级表（如平台预置字典）不继承此类，或允许 tenant_id 为 null。
 */
export abstract class TenantEntity extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'int' })
  tenantId: number;
}
