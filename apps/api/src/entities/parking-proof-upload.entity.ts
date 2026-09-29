import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 办公室发起的亲情车证明材料临时上传会话。原始 token 只放在二维码中，库里仅存哈希。 */
@Entity('parking_proof_uploads')
@Index(['tokenHash'], { unique: true })
@Index(['tenantId', 'plate'])
@Index(['expiresAt'])
export class ParkingProofUpload extends TenantEntity {
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
}
