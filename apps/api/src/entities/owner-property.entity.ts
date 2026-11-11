import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';
import { House } from './house.entity';
import { Building } from './building.entity';

@Entity('owner_property_links')
@Check('ck_owner_property_target', '(house_id IS NOT NULL)::int + (building_id IS NOT NULL)::int = 1')
@Index('uq_owner_property_house', ['tenantId', 'ownerId', 'houseId'], { unique: true, where: 'house_id IS NOT NULL' })
@Index('uq_owner_property_shop', ['tenantId', 'ownerId', 'buildingId'], { unique: true, where: 'building_id IS NOT NULL' })
@Index('ix_owner_property_house', ['tenantId', 'houseId'])
@Index('ix_owner_property_building', ['tenantId', 'buildingId'])
export class OwnerPropertyLink {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'int' }) tenantId: number;
  @Column({ name: 'owner_id', type: 'int' }) ownerId: number;
  @ManyToOne(() => User) @JoinColumn({ name: 'owner_id' }) owner: User;
  @Column({ name: 'house_id', type: 'int', nullable: true }) houseId: number | null;
  @ManyToOne(() => House, { nullable: true }) @JoinColumn({ name: 'house_id' }) house: House | null;
  @Column({ name: 'building_id', type: 'int', nullable: true }) buildingId: number | null;
  @ManyToOne(() => Building, { nullable: true }) @JoinColumn({ name: 'building_id' }) building: Building | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('owner_phone_activity')
export class OwnerPhoneActivity {
  @PrimaryColumn({ name: 'tenant_id', type: 'int' }) tenantId: number;
  @PrimaryColumn({ name: 'owner_id', type: 'int' }) ownerId: number;
  @ManyToOne(() => User) @JoinColumn({ name: 'owner_id' }) owner: User;
  @PrimaryColumn({ type: 'varchar', length: 30 }) phone: string;
  @Column({ type: 'varchar', length: 20, default: 'unknown' }) status: string;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;
  @Column({ name: 'last_contacted_at', type: 'timestamptz', nullable: true }) lastContactedAt: Date | null;
  @Column({ name: 'last_attempted_at', type: 'timestamptz', nullable: true }) lastAttemptedAt: Date | null;
  @Column({ name: 'last_result', type: 'varchar', length: 20, nullable: true }) lastResult: string | null;
  @Column({ name: 'updated_by', type: 'int', nullable: true }) updatedBy: number | null;
}

@Entity('owner_phone_events')
export class OwnerPhoneEvent {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'int' }) tenantId: number;
  @Column({ name: 'owner_id', type: 'int' }) ownerId: number;
  @ManyToOne(() => User) @JoinColumn({ name: 'owner_id' }) owner: User;
  @Column({ type: 'varchar', length: 30 }) phone: string;
  @Column({ type: 'varchar', length: 20 }) result: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) note: string | null;
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @Column({ name: 'operator_id', type: 'int', nullable: true }) operatorId: number | null;
}
