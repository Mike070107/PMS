import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export type ParkingHistoryEventType = 'plate_change' | 'owner_rebind' | 'owner_info_update' | 'vehicle_added' | 'vehicle_renewed' | 'garage_authorization' | 'vehicle_deleted' | 'vehicle_download';
export type ParkingHistoryTimeBasis = 'operation' | 'detected';

export interface ParkingHistoryChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

/**
 * 停车档案的不可变变更流水。
 *
 * 网关每次查询后用稳定的 Car_Issue 记录号与上次快照比较；换牌事件再从 Up_Issue
 * 补真实业务时间。PMS 自己的业主资料修改则在保存事务里直接写入这里。
 */
@Entity('parking_history')
@Index(['tenantId', 'pmsUserId', 'occurredAt'])
@Index(['tenantId', 'database', 'externalOwnerId', 'occurredAt'])
@Index(['tenantId', 'plateAfter', 'occurredAt'])
@Index(['tenantId', 'plateBefore', 'occurredAt'])
export class ParkingHistory extends TenantEntity {
  @Column({ name: 'event_type', type: 'varchar', length: 30 })
  eventType: ParkingHistoryEventType;

  @Column({ type: 'varchar', length: 20 })
  source: 'pms' | 'parking_gateway';

  @Column({ type: 'varchar', length: 80, nullable: true })
  database: string | null;

  @Column({ name: 'source_record_id', type: 'varchar', length: 100, nullable: true })
  sourceRecordId: string | null;

  @Column({ name: 'pms_user_id', type: 'int', nullable: true })
  pmsUserId: number | null;

  @Column({ name: 'external_owner_id', type: 'varchar', length: 100, nullable: true })
  externalOwnerId: string | null;

  @Column({ name: 'plate_before', type: 'varchar', length: 20, nullable: true })
  plateBefore: string | null;

  @Column({ name: 'plate_after', type: 'varchar', length: 20, nullable: true })
  plateAfter: string | null;

  @Column({ type: 'varchar', length: 300 })
  summary: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  changes: ParkingHistoryChange[];

  @Column({ name: 'operator_user_id', type: 'int', nullable: true })
  operatorUserId: number | null;

  @Column({ name: 'detected_by_query_id', type: 'int', nullable: true })
  detectedByQueryId: number | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  /** 旧库有真实业务流水时间时为 operation；否则只能说明 PMS 何时发现变化。 */
  // 默认必须保守地视为“检测时间”：生产使用 schema synchronize，旧网关历史加列时会取得默认值。
  // PMS 与新版网关产生的记录都会在写入时显式声明 operation。
  @Column({ name: 'time_basis', type: 'varchar', length: 20, default: 'detected' })
  timeBasis: ParkingHistoryTimeBasis;
}
