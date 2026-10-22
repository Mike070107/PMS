import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 办公室发起的亲情车证明材料临时上传会话。原始 token 只放在二维码中，库里仅存哈希。 */
@Entity('parking_proof_uploads')
@Index(['tokenHash'], { unique: true })
@Index(['tenantId', 'plate'])
@Index(['expiresAt'])
export class ParkingProofUpload extends TenantEntity {
  @Column({ name: 'review_status', type: 'varchar', length: 20, default: 'pending' })
  reviewStatus: 'pending' | 'approved' | 'rejected';

  @Column({ name: 'review_reason', type: 'text', nullable: true })
  reviewReason: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy: number | null;

  @Column({ name: 'registration_id', type: 'int', nullable: true })
  registrationId: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  files: Array<{ objectKey: string; fileName: string; contentType: string }>;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'varchar', length: 20 })
  plate: string;

  @Column({ name: 'owner_id', type: 'varchar', length: 50, nullable: true })
  ownerId: string | null;

  @Column({ name: 'requested_by', type: 'int' })
  requestedBy: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'object_key', type: 'varchar', length: 500, nullable: true })
  objectKey: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 255, nullable: true })
  fileName: string | null;

  @Column({ name: 'content_type', type: 'varchar', length: 100, nullable: true })
  contentType: string | null;

  /** 亲情车管理页发起的上传会话；为空表示旧的停车管理入口 */
  @Column({ name: 'family_car_id', type: 'int', nullable: true })
  familyCarId: number | null;

  /** 业主扫码时填写的车主信息（车主姓名、电话、关系），提交时写回亲情车登记 */
  @Column({ type: 'jsonb', nullable: true })
  form: Record<string, string> | null;
}
