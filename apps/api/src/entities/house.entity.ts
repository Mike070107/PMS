import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { Building } from './building.entity';
import { Unit } from './unit.entity';

/** 房号（最细粒度的报修定位单位） */
@Entity('houses')
@Index(['tenantId', 'buildingId'])
export class House extends TenantEntity {
  @Column({ name: 'building_id', type: 'int' })
  buildingId: number;

  @ManyToOne(() => Building)
  @JoinColumn({ name: 'building_id' })
  building: Building;

  // 单元可空（部分小区无单元概念）
  @Column({ name: 'unit_id', type: 'int', nullable: true })
  unitId: number | null;

  @ManyToOne(() => Unit, { nullable: true })
  @JoinColumn({ name: 'unit_id' })
  unit: Unit | null;

  @Column({ name: 'room_no', type: 'varchar', length: 30 })
  roomNo: string;

  @Column({ name: 'property_type', type: 'varchar', length: 20, default: '住宅' })
  propertyType: string;

  @Column({ name: 'road_name', type: 'varchar', length: 60, nullable: true })
  roadName: string | null;

  @Column({ name: 'full_address', type: 'varchar', length: 255, nullable: true })
  fullAddress: string | null;

  @Column({ name: 'shop_name', type: 'varchar', length: 120, nullable: true })
  shopName: string | null;

  /** 建筑面积（平方米），保留两位小数。可空——历史房产未登记时为 null */
  @Column({ name: 'area_sqm', type: 'numeric', precision: 7, scale: 2, nullable: true })
  areaSqm: string | null;
}
