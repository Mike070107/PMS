import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import type { ParkingSnapshotValues } from '../modules/access-card-issuance/parking-history.util';

/** 最近一次读到的旧库车辆快照；只用于计算变化，不直接当历史展示。 */
@Entity('parking_record_snapshots')
@Index(['tenantId', 'database', 'sourceRecordId'], { unique: true })
export class ParkingRecordSnapshot extends TenantEntity {
  @Column({ type: 'varchar', length: 80 })
  database: string;

  @Column({ name: 'source_record_id', type: 'varchar', length: 100 })
  sourceRecordId: string;

  @Column({ type: 'jsonb' })
  values: ParkingSnapshotValues;

  @Column({ name: 'observed_at', type: 'timestamptz' })
  observedAt: Date;
}
