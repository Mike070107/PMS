import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { QrGranularity } from '../common/enums';

/**
 * 张贴的二维码。业主扫码后用 token 解析出默认带出的位置信息。
 * - community 粒度：只带出小区，业主手选弄/号/房号
 * - building 粒度：带出弄/号，业主只补房号
 *
 * token 同时充当微信小程序码的 scene（getUnlimited 的 scene 限 32 个可见字符，
 * 允许 数字/英文/!#$&'()*+,/:;=?@-._~ ；nanoid 的字母表是 A-Za-z0-9_- ，正好在范围内）。
 */
@Entity('qr_codes')
@Index(['token'], { unique: true })
@Index(['tenantId'])
@Index(['tenantId', 'buildingId'])
export class QrCode extends TenantEntity {
  @Column({ type: 'varchar', length: 32 })
  token: string; // nanoid，既是 URL 标识也是小程序码 scene

  @Column({ type: 'varchar', length: 20 })
  granularity: QrGranularity;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'building_id', type: 'int', nullable: true })
  buildingId: number | null;

  // 贴码位置说明，便于物业管理（如"3 号楼一楼大厅"）
  @Column({ name: 'place_note', type: 'varchar', length: 120, nullable: true })
  placeNote: string | null;

  /**
   * 印在码旁边的文案，生成时定好并落库（如「枫桦景苑二期 228弄3号 · 扫码报修」）。
   * 之后小区/楼栋改名不会自动改动已印出去的码，需要人工点「重新生成」。
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  caption: string | null;

  /** 小程序码图片地址（对象存储公网 URL）。null = 还没生成成功 */
  @Column({ name: 'image_url', type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  /** 生成时用的小程序落地页，便于排查「扫码进错页」 */
  @Column({ name: 'target_page', type: 'varchar', length: 120, nullable: true })
  targetPage: string | null;

  /** release / trial / develop —— 生成时用的小程序版本 */
  @Column({ name: 'env_version', type: 'varchar', length: 20, nullable: true })
  envVersion: string | null;

  @Column({ name: 'generated_at', type: 'timestamptz', nullable: true })
  generatedAt: Date | null;

  /** 上次生成失败的原因（原样保留微信返回的 errcode/errmsg，方便后台直接看） */
  @Column({ name: 'last_error', type: 'varchar', length: 300, nullable: true })
  lastError: string | null;

  @Column({ default: true })
  enabled: boolean;
}
