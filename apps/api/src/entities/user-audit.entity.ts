import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { AuditStatus } from '../common/enums';

/** 业主入驻审核流水 */
@Entity('user_audits')
@Index(['tenantId', 'status'])
export class UserAudit extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  // 申请时填写的房号定位
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'building_id', type: 'int', nullable: true })
  buildingId: number | null;

  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  // 业主自填的原始定位文本（弄/号/房号），审核通过后落到 houses
  @Column({ name: 'raw_address', type: 'varchar', length: 255, nullable: true })
  rawAddress: string | null;

  @Column({ name: 'applicant_name', type: 'varchar', length: 60, nullable: true })
  applicantName: string | null;

  @Column({ name: 'applicant_phone', type: 'varchar', length: 30, nullable: true })
  applicantPhone: string | null;

  @Column({ type: 'varchar', length: 20, default: AuditStatus.PENDING })
  status: AuditStatus;

  // 驳回理由
  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason: string | null;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy: number | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}
