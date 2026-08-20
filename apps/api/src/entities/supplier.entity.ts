import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 供应商档案 */
@Entity('suppliers')
@Index(['tenantId'])
export class Supplier extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 60, nullable: true })
  contactName: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 30, nullable: true })
  contactPhone: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address: string | null;

  // 收货评级 1-5（手工维护）
  @Column({ type: 'int', nullable: true })
  rating: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ default: true })
  enabled: boolean;
}
