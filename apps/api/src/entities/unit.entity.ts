import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Building } from './building.entity';

/** 单元（一栋楼下的单元，可选层级） */
@Entity('units')
@Index(['tenantId', 'buildingId'])
export class Unit extends TenantEntity {
  @Column({ name: 'building_id', type: 'int' })
  buildingId: number;

  @ManyToOne(() => Building)
  @JoinColumn({ name: 'building_id' })
  building: Building;

  @Column({ name: 'unit_no', type: 'varchar', length: 30 })
  unitNo: string;
}
