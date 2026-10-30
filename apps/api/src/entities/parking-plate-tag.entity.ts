import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 车牌 → 缴费规则分组（vehicle_class 存分组名）。原「车牌分类标记」（业主车 / 租客车 / 大车 / 小车……与收费标准里自建的类别一致）。
 * 车辆本身登记在各停车系统（旧库、德立云），PMS 只在这里记「按哪类收费」，续期时据此选收费标准。
 */
@Entity('parking_plate_tags')
@Index(['tenantId', 'plate'], { unique: true })
export class ParkingPlateTag extends TenantEntity {
  @Column({ type: 'varchar', length: 10 })
  plate: string;

  @Column({ name: 'vehicle_class', type: 'varchar', length: 40 })
  vehicleClass: string;

  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;
}
