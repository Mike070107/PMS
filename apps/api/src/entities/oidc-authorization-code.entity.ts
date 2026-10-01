import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/** Cloudflare 用授权码换令牌时使用；只保存授权码哈希，且每个码只能消费一次。 */
@Entity('oidc_authorization_codes')
@Index(['codeHash'], { unique: true })
@Index(['expiresAt'])
export class OidcAuthorizationCode extends BaseEntity {
  @Column({ name: 'code_hash', type: 'char', length: 64 })
  codeHash: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'client_id', type: 'varchar', length: 160 })
  clientId: string;

  @Column({ name: 'redirect_uri', type: 'varchar', length: 500 })
  redirectUri: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  nonce: string | null;

  @Column({ name: 'code_challenge', type: 'varchar', length: 128, nullable: true })
  codeChallenge: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
