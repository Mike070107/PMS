import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/** 扫码登录票据的状态流转：pending → scanned → confirmed（或 cancelled / 过期） */
export enum WebLoginTicketStatus {
  PENDING = 'pending', // 已出码，还没人扫
  SCANNED = 'scanned', // 小程序打开了，等本人在手机上点确认
  CONFIRMED = 'confirmed', // 已确认，网页下一次轮询就能换到 token
  CONSUMED = 'consumed', // token 已被取走，票据作废（一次性）
  CANCELLED = 'cancelled', // 本人在手机上点了「不是我」
}

/**
 * 后台网页的微信扫码登录票据。
 *
 * 没有租户列：出码时还不知道是谁，租户要等确认之后才从用户身上取。
 *
 * 为什么不放 Redis：这张表的行很少、生命周期两分钟，用 Postgres 和现有
 * TypeORM 一套走完即可，省掉为它单独引一套 Redis 客户端和连接管理；
 * 过期行由 tasks 里的定时清理收走（见 TasksService）。
 */
@Entity('web_login_tickets')
@Index(['ticket'], { unique: true })
@Index(['expiresAt'])
export class WebLoginTicket extends BaseEntity {
  /**
   * 一次性随机串，同时用作小程序码的 scene。
   * 微信限制 scene 最长 32 个可见字符，所以这里固定 24 位 base62。
   */
  @Column({ type: 'varchar', length: 32 })
  ticket: string;

  @Column({ type: 'varchar', length: 20, default: WebLoginTicketStatus.PENDING })
  status: WebLoginTicketStatus;

  /** 确认授权的员工；确认前为 null */
  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  /**
   * 出码那台机器的 IP 和浏览器，原样展示在手机确认页上。
   * 「谁在什么地方要登录」是本人判断该不该点确认的唯一依据 ——
   * 只给一句「确认登录吗」，被钓鱼时没人分得出来。
   */
  @Column({ name: 'client_ip', type: 'varchar', length: 64, nullable: true })
  clientIp: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;
}
