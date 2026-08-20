import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { House } from './house.entity';
import { User } from './user.entity';

/** 业主门禁卡清单 */
@Entity('access_cards')
@Index(['tenantId', 'cardNo'], { unique: true })
export class AccessCard extends TenantEntity {
  @Column({ name: 'card_no', type: 'varchar', length: 40 })
  cardNo: string;

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

  @Column({ name: 'card_type', type: 'varchar', length: 30, default: 'standard' })
  cardType: string;

  @Column({ name: 'external_ref', type: 'varchar', length: 80, nullable: true })
  externalRef: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string;
}
