import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

export enum ExternalAccountBindingStatus {
  ACTIVE = 'active',
  INVALID = 'invalid',
  REVOKED = 'revoked',
}

/** PMS 员工与某个无源码内网应用账号的一对一映射。 */
@Entity('external_account_bindings')
@Index(['tenantId', 'appId', 'userId'], { unique: true })
@Index(['appId', 'remoteUserId'], { unique: true, where: `"status" = 'active'` })
export class ExternalAccountBinding extends TenantEntity {
  @Column({ name: 'app_id', type: 'int' })
  appId: number;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'remote_user_id', type: 'varchar', length: 120 })
  remoteUserId: string;

  @Column({ name: 'remote_username', type: 'varchar', length: 120 })
  remoteUsername: string;

  @Column({ name: 'remote_display_name', type: 'varchar', length: 120, nullable: true })
  remoteDisplayName: string | null;

  /** AES-256-GCM 密文包；v1.iv.tag.ciphertext，不保存明文。 */
  @Column({ name: 'credential_payload', type: 'text' })
  credentialPayload: string;

  @Column({ type: 'varchar', length: 20, default: ExternalAccountBindingStatus.ACTIVE })
  status: ExternalAccountBindingStatus;

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt: Date;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;
}
