import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { LessThan, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { STAFF_APP_ROLES, UserRole, USER_ROLE_LABELS } from '../../common/enums';
import { User, WebLoginTicket } from '../../entities';
import { WebLoginTicketStatus } from '../../entities/web-login-ticket.entity';
import { AuthService } from './auth.service';
import { WechatService, type WxEnvVersion } from './wechat.service';

/** 票据有效期。太长会让一张被拍走的码一直可用，太短又赶不上掏手机的时间 */
const TICKET_TTL_SEC = 120;

/** 员工端小程序里的确认页 */
const CONFIRM_PAGE = 'pages/web-login/web-login';

/** scene 只允许数字/英文和少数符号，且最长 32 位，所以用 base62 自己生成 */
const SCENE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomScene(length = 24): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SCENE_ALPHABET[bytes[i] % SCENE_ALPHABET.length];
  }
  return out;
}

/**
 * 后台网页的微信扫码登录。
 *
 * 流程：网页出小程序码 → 本人用微信扫开【邻修管理】→ 小程序里点确认 →
 * 网页轮询换到 token。
 *
 * 为什么不用微信开放平台的「网站应用」扫码：那需要企业资质和年审费，
 * 而且拿到的只是「这个微信是谁」，仍然要再和员工库对一次。走员工端小程序
 * 等于直接复用已有的身份链条 —— 能扫开确认的人，必然已经用微信手机号
 * 匹配过用户管理里的档案（见 staffLogin），扫码本身又是一次本人确认。
 *
 * 两道闸门都在，别拆：
 * 1. 手机号必须在用户管理里 —— 由员工端登录流程保证；
 * 2. 还得绑了后台角色才进得来 —— issueWebTokensForUser 里的 assertWebAdminAccess。
 */
@Injectable()
export class QrLoginService {
  private readonly logger = new Logger(QrLoginService.name);

  constructor(
    @InjectRepository(WebLoginTicket)
    private readonly ticketRepo: Repository<WebLoginTicket>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly wechat: WechatService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  /** 出码。返回 base64 图片，省掉为一张两分钟就作废的图走一趟对象存储 */
  async createTicket(clientIp?: string, userAgent?: string) {
    const ticket = randomScene();
    const expiresAt = new Date(Date.now() + TICKET_TTL_SEC * 1000);

    const png = await this.wechat.getUnlimitedWxaCode(
      {
        scene: ticket,
        page: CONFIRM_PAGE,
        width: 430,
        envVersion: this.envVersion(),
      },
      'staff',
    );

    await this.ticketRepo.save(
      this.ticketRepo.create({
        ticket,
        status: WebLoginTicketStatus.PENDING,
        userId: null,
        expiresAt,
        confirmedAt: null,
        clientIp: clientIp?.slice(0, 64) ?? null,
        userAgent: userAgent?.slice(0, 300) ?? null,
        createdBy: null,
        updatedBy: null,
      }),
    );

    return {
      ticket,
      qrImage: `data:image/png;base64,${png.toString('base64')}`,
      expiresIn: TICKET_TTL_SEC,
    };
  }

  /**
   * 网页轮询。确认过就把 token 一起给出去，并立刻把票据标成已消费 ——
   * 一张码只能换一次 token，被人拍照转发也没用。
   */
  async pollStatus(ticketCode: string) {
    const row = await this.findTicket(ticketCode);
    if (!row) return { status: 'expired' as const };

    if (this.isExpired(row)) {
      return { status: 'expired' as const };
    }
    if (row.status === WebLoginTicketStatus.CANCELLED) {
      return { status: 'cancelled' as const };
    }
    if (row.status === WebLoginTicketStatus.CONSUMED) {
      // 已经换过一次 token 了，不再重复发
      return { status: 'expired' as const };
    }
    if (row.status !== WebLoginTicketStatus.CONFIRMED || !row.userId) {
      return { status: row.status as 'pending' | 'scanned' };
    }

    // 先落 CONSUMED 再发 token：两个标签页同时轮询时只会有一个换到
    const claimed = await this.ticketRepo.update(
      { id: row.id, status: WebLoginTicketStatus.CONFIRMED },
      { status: WebLoginTicketStatus.CONSUMED, updatedBy: row.userId },
    );
    if (!claimed.affected) return { status: 'expired' as const };

    const tokens = await this.authService.issueWebTokensForUser(row.userId);
    this.logger.log(`扫码登录成功：用户 #${row.userId}（ticket ${ticketCode.slice(0, 6)}…）`);
    return { status: 'confirmed' as const, ...tokens };
  }

  /**
   * 小程序扫开后调这个，把「谁在哪台机器上要登录」告诉本人。
   * 只标记状态，不发任何令牌 —— 确认动作必须是本人再点一次。
   */
  async markScanned(ticketCode: string, user: AuthUser) {
    const row = await this.requireUsableTicket(ticketCode);
    this.assertStaffApp(user);

    if (row.status === WebLoginTicketStatus.PENDING) {
      row.status = WebLoginTicketStatus.SCANNED;
      row.updatedBy = user.id;
      await this.ticketRepo.save(row);
    }

    const me = await this.userRepo.findOne({ where: { id: user.id } });
    return {
      ticket: row.ticket,
      status: row.status,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      requestedAt: row.createdAt,
      expiresAt: row.expiresAt,
      me: {
        name: me?.name ?? null,
        roleLabel: me ? USER_ROLE_LABELS[me.role] ?? me.role : null,
      },
    };
  }

  /** 本人点「确认登录」 */
  async confirm(ticketCode: string, user: AuthUser) {
    const row = await this.requireUsableTicket(ticketCode);
    this.assertStaffApp(user);
    if (row.status === WebLoginTicketStatus.CONFIRMED) {
      return { ok: true as const };
    }
    if (row.status !== WebLoginTicketStatus.PENDING && row.status !== WebLoginTicketStatus.SCANNED) {
      throw new BadRequestException('这个二维码已经用过或已取消，请让网页刷新一张');
    }

    // 没有后台权限的人（没绑角色的维修工、保安等）在手机上就要看到原因，
    // 别让他点完确认、网页那边再报一句他看不见的错
    await this.authService.issueWebTokensForUser(user.id);

    row.status = WebLoginTicketStatus.CONFIRMED;
    row.userId = user.id;
    row.confirmedAt = new Date();
    row.updatedBy = user.id;
    await this.ticketRepo.save(row);
    return { ok: true as const };
  }

  /** 本人点「不是我」：立刻作废，网页那边会提示已取消 */
  async cancel(ticketCode: string, user: AuthUser) {
    const row = await this.findTicket(ticketCode);
    if (!row) return { ok: true as const };
    if (row.status === WebLoginTicketStatus.CONSUMED) {
      throw new BadRequestException('这次登录已经完成，如需退出请在网页里退出登录');
    }
    row.status = WebLoginTicketStatus.CANCELLED;
    row.updatedBy = user.id;
    await this.ticketRepo.save(row);
    return { ok: true as const };
  }

  /** 定时清理：过期票据留着只会让表越长越大，对账也没有价值 */
  async purgeExpired(): Promise<number> {
    const res = await this.ticketRepo.delete({
      expiresAt: LessThan(new Date(Date.now() - 3600 * 1000)),
    });
    return res.affected ?? 0;
  }

  private async findTicket(ticketCode: string) {
    const code = String(ticketCode || '').trim();
    if (!code || code.length > 32) return null;
    return this.ticketRepo.findOne({ where: { ticket: code } });
  }

  private async requireUsableTicket(ticketCode: string) {
    const row = await this.findTicket(ticketCode);
    if (!row) throw new NotFoundException('二维码无效，请让网页刷新一张');
    if (this.isExpired(row)) {
      throw new BadRequestException('二维码已过期，请让网页刷新一张');
    }
    return row;
  }

  private isExpired(row: WebLoginTicket) {
    return row.expiresAt.getTime() < Date.now();
  }

  /**
   * 只有员工端身份能确认。业主端的 token 打不到这里来（角色对不上），
   * 但显式拦一道，免得以后哪个端复用了这个接口。
   */
  private assertStaffApp(user: AuthUser) {
    if (!STAFF_APP_ROLES.includes(user.role as UserRole)) {
      throw new ForbiddenException('请在「邻修管理」员工端小程序里确认');
    }
  }

  private envVersion(): WxEnvVersion {
    const value = this.config.get<string>('WX_STAFF_QR_ENV_VERSION', 'release');
    return value === 'trial' || value === 'develop' ? value : 'release';
  }
}
