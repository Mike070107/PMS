import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { House } from './house.entity';
import { User } from './user.entity';

/** 业主名下车辆，用于停车月租办理 */
@Entity('parking_vehicles')
@Index(['tenantId', 'plateNo'], { unique: true })
export class ParkingVehicle extends TenantEntity {
  @Column({ name: 'plate_no', type: 'varchar', length: 20 })
  plateNo: string;

  @Column({ name: 'house_id', type: 'int' })
  houseId: number;

  @ManyToOne(() => House)
  @JoinColumn({ name: 'house_id' })
  house: House;

  @Column({ name: 'owner_id', type: 'int', nullable: true })
  ownerId: number | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'owner_id' })
  owner: User | null;

  @Column({ name: 'valid_until', type: 'date', nullable: true })
  validUntil: string | null;

  @Column({ name: 'external_ref', type: 'varchar', length: 80, nullable: true })
  externalRef: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string;
}
