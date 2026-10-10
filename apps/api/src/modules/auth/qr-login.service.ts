import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { STAFF_APP_ROLES, UserRole, USER_ROLE_LABELS } from '../../common/enums';
import { ExternalAccessApp, User, WebLoginTicket } from '../../entities';
import {
  OidcLoginRequest,
  WebLoginTicketPurpose,
  WebLoginTicketStatus,
} from '../../entities/web-login-ticket.entity';
import { AuthService } from './auth.service';
import { ExternalAccountBindingService } from './external-account-binding.service';
import { OidcService } from './oidc.service';
import { WechatService, type WxEnvVersion } from './wechat.service';
import {
  browserSecretMatches,
  createBrowserBinding,
} from './qr-login-security';

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
  private readonly rateWindows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @InjectRepository(WebLoginTicket)
    private readonly ticketRepo: Repository<WebLoginTicket>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ExternalAccessApp)
    private readonly externalAppRepo: Repository<ExternalAccessApp>,
    private readonly wechat: WechatService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    private readonly oidcService: OidcService,
    private readonly externalBindings: ExternalAccountBindingService,
  ) {}

  /** 出码。返回 base64 图片，省掉为一张两分钟就作废的图走一趟对象存储 */
  async createTicket(
    clientIp?: string,
    userAgent?: string,
    options?: {
      purpose: WebLoginTicketPurpose;
      oidcRequest?: OidcLoginRequest;
      requiredApp?: ExternalAccessApp;
    },
  ) {
    this.assertRateLimit('create', clientIp || 'unknown', 6, 60_000);
    if (clientIp) {
      const recent = await this.ticketRepo.count({
        where: { clientIp, createdAt: MoreThan(new Date(Date.now() - 60_000)) },
      });
      if (recent >= 6) throw new HttpException('二维码生成过于频繁，请一分钟后再试', 429);
    }
    const ticket = randomScene();
    const expiresAt = new Date(Date.now() + TICKET_TTL_SEC * 1000);
    const browser = createBrowserBinding();
    const oidcRequest = options?.requiredApp
      ? {
          clientId: 'pms-gateway',
          redirectUri: `https://${options.requiredApp.publicHostname}/`,
          state: randomBytes(16).toString('base64url'),
          requiredAppId: options.requiredApp.id,
          requiredAppSlug: options.requiredApp.slug,
          requiredAppName: options.requiredApp.name,
          requiredAppHostname: options.requiredApp.publicHostname,
        }
      : options?.oidcRequest
      ? await this.bindOidcRequestToApplication(options.oidcRequest)
      : null;

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
        purpose: options?.purpose ?? WebLoginTicketPurpose.ADMIN,
        oidcRequest,
        userId: null,
        scannedByUserId: null,
        browserSecretHash: browser.hash,
        expiresAt,
        confirmedAt: null,
        clientIp: clientIp?.slice(0, 64) ?? null,
        userAgent: userAgent?.slice(0, 300) ?? null,
        createdBy: null,
        updatedBy: null,
      }),
    );

    // 同一部手机无法扫描自己屏幕上的码；电脑用户也常已登录桌面微信。
    // Scheme 失败不能拖垮原有二维码登录，所以这里只降级记录并保留二维码。
    let launchScheme: string | null = null;
    try {
      launchScheme = await this.wechat.generateWxaUrlScheme(
        {
          path: CONFIRM_PAGE,
          query: `ticket=${ticket}`,
          envVersion: this.envVersion(),
          expiresAt,
        },
        'staff',
      );
    } catch (err) {
      this.logger.warn(`生成微信同机授权入口失败，继续使用二维码：${(err as Error).message}`);
    }

    return {
      ticket,
      qrImage: `data:image/png;base64,${png.toString('base64')}`,
      expiresIn: TICKET_TTL_SEC,
      browserSecret: browser.secret,
      launchScheme,
      applicationName: oidcRequest?.requiredAppName ?? 'PMS 物业管理后台',
      applicationHostname: oidcRequest?.requiredAppHostname ?? null,
    };
  }

  /**
   * 网页轮询。确认过就把 token 一起给出去，并立刻把票据标成已消费 ——
   * 一张码只能换一次 token，被人拍照转发也没用。
   */
  async pollStatus(ticketCode: string, browserSecret?: string, clientIp?: string) {
    this.assertRateLimit('poll', clientIp || 'unknown', 120, 60_000);
    const row = await this.findTicket(ticketCode);
    if (!row) return { status: 'expired' as const };
    if (row.purpose !== WebLoginTicketPurpose.ADMIN) {
      return { status: 'expired' as const };
    }

    if (this.isExpired(row)) {
      return { status: 'expired' as const };
    }
    this.assertBrowserBinding(row, browserSecret);
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

  /** Cloudflare OIDC 授权页轮询；只返回一次性授权码跳转地址，不发 PMS JWT。 */
  async pollExternalOidcStatus(ticketCode: string, browserSecret?: string, clientIp?: string) {
    this.assertRateLimit('oidc-poll', clientIp || 'unknown', 120, 60_000);
    const row = await this.findTicket(ticketCode);
    if (!row || row.purpose !== WebLoginTicketPurpose.EXTERNAL_ACCESS_OIDC) {
      return { status: 'expired' as const };
    }
    if (this.isExpired(row)) return { status: 'expired' as const };
    this.assertBrowserBinding(row, browserSecret);
    if (row.status === WebLoginTicketStatus.CANCELLED) {
      return { status: 'cancelled' as const };
    }
    if (row.status === WebLoginTicketStatus.CONSUMED) {
      return { status: 'expired' as const };
    }
    if (row.status !== WebLoginTicketStatus.CONFIRMED || !row.userId || !row.oidcRequest) {
      return { status: row.status as 'pending' | 'scanned' };
    }

    const claimed = await this.ticketRepo.update(
      { id: row.id, status: WebLoginTicketStatus.CONFIRMED },
      { status: WebLoginTicketStatus.CONSUMED, updatedBy: row.userId },
    );
    if (!claimed.affected) return { status: 'expired' as const };

    const required = this.requiredApplication(row);
    await this.authService.requireExternalAccessUser(row.userId, required);
    const redirectTo = await this.oidcService.createAuthorizationCode(
      row.userId,
      row.oidcRequest,
    );
    this.logger.log(`内网应用扫码授权成功：用户 #${row.userId}`);
    return { status: 'confirmed' as const, redirectTo };
  }

  /** 国内动态网关轮询：消费一次性票据并返回服务端签发会话所需的最小信息。 */
  async pollExternalGatewayStatus(ticketCode: string, browserSecret?: string, clientIp?: string) {
    this.assertRateLimit('gateway-poll', clientIp || 'unknown', 120, 60_000);
    const row = await this.findTicket(ticketCode);
    if (!row || row.purpose !== WebLoginTicketPurpose.EXTERNAL_GATEWAY) return { status: 'expired' as const };
    if (this.isExpired(row)) return { status: 'expired' as const };
    this.assertBrowserBinding(row, browserSecret);
    if (row.status === WebLoginTicketStatus.CANCELLED) return { status: 'cancelled' as const };
    if (row.status === WebLoginTicketStatus.CONSUMED) return { status: 'expired' as const };
    if (row.status !== WebLoginTicketStatus.CONFIRMED || !row.userId) {
      return { status: row.status as 'pending' | 'scanned' };
    }
    const claimed = await this.ticketRepo.update(
      { id: row.id, status: WebLoginTicketStatus.CONFIRMED },
      { status: WebLoginTicketStatus.CONSUMED, updatedBy: row.userId },
    );
    if (!claimed.affected) return { status: 'expired' as const };
    const required = this.requiredApplication(row);
    await this.authService.requireExternalAccessUser(row.userId, required);
    return { status: 'confirmed' as const, userId: row.userId, appId: required.appId };
  }

  /**
   * 小程序扫开后调这个，把「谁在哪台机器上要登录」告诉本人。
   * 只标记状态，不发任何令牌 —— 确认动作必须是本人再点一次。
   */
  async markScanned(ticketCode: string, user: AuthUser) {
    this.assertRateLimit('scan', String(user.id), 20, 5 * 60_000);
    const row = await this.requireUsableTicket(ticketCode);
    this.assertStaffApp(user);
    if (row.status === WebLoginTicketStatus.CANCELLED || row.status === WebLoginTicketStatus.CONSUMED) {
      throw new BadRequestException('这个二维码已经用过或已取消，请让网页刷新一张');
    }

    if (row.status === WebLoginTicketStatus.PENDING) {
      const claimed = await this.ticketRepo.update(
        { id: row.id, status: WebLoginTicketStatus.PENDING, scannedByUserId: IsNull() },
        { status: WebLoginTicketStatus.SCANNED, scannedByUserId: user.id, updatedBy: user.id },
      );
      if (claimed.affected) {
        row.status = WebLoginTicketStatus.SCANNED;
        row.scannedByUserId = user.id;
      } else {
        const current = await this.findTicket(ticketCode);
        if (!current) throw new NotFoundException('二维码无效，请让网页刷新一张');
        row.status = current.status;
        row.scannedByUserId = current.scannedByUserId;
      }
    }
    if (row.scannedByUserId !== user.id) {
      throw new ForbiddenException('这个二维码已由另一位员工扫描，请让电脑刷新二维码');
    }

    const me = await this.userRepo.findOne({ where: { id: user.id } });
    const requiredApp = row.purpose === WebLoginTicketPurpose.EXTERNAL_GATEWAY
      ? await this.externalApp(row)
      : null;
    const binding = requiredApp
      ? await this.externalBindings.bindingState(requiredApp, user.id)
      : { required: false, bound: true, username: null };
    return {
      ticket: row.ticket,
      status: row.status,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      requestedAt: row.createdAt,
      expiresAt: row.expiresAt,
      applicationName:
        row.oidcRequest?.requiredAppName ?? 'PMS 物业管理后台',
      applicationHostname: row.oidcRequest?.requiredAppHostname ?? null,
      bindingRequired: binding.required && !binding.bound,
      bindingUsername: binding.username,
      me: {
        name: me?.name ?? null,
        roleLabel: me ? USER_ROLE_LABELS[me.role] ?? me.role : null,
      },
    };
  }

  /** 本人点「确认登录」 */
  async confirm(ticketCode: string, user: AuthUser) {
    this.assertRateLimit('confirm', String(user.id), 12, 5 * 60_000);
    const row = await this.requireUsableTicket(ticketCode);
    this.assertStaffApp(user);
    if (row.status === WebLoginTicketStatus.CONFIRMED) {
      if (row.userId === user.id) return { ok: true as const };
      throw new ForbiddenException('这次登录已由另一位员工确认');
    }
    if (row.status !== WebLoginTicketStatus.SCANNED || row.scannedByUserId !== user.id) {
      throw new BadRequestException('这个二维码已经用过或已取消，请让网页刷新一张');
    }

    // 没有后台权限的人（没绑角色的维修工、保安等）在手机上就要看到原因，
    // 别让他点完确认、网页那边再报一句他看不见的错
    if ([WebLoginTicketPurpose.EXTERNAL_ACCESS_OIDC, WebLoginTicketPurpose.EXTERNAL_GATEWAY].includes(row.purpose)) {
      await this.authService.requireExternalAccessUser(user.id, this.requiredApplication(row));
    } else {
      await this.authService.issueWebTokensForUser(user.id);
    }

    if (row.purpose === WebLoginTicketPurpose.EXTERNAL_GATEWAY) {
      const app = await this.externalApp(row);
      const binding = await this.externalBindings.bindingState(app, user.id);
      if (binding.required && !binding.bound) {
        return { ok: false as const, bindingRequired: true as const };
      }
    }

    return this.completeConfirmation(row, user.id);
  }

  /** 首次绑定：验证原系统账密、加密保存，再完成这张扫码票据。 */
  async bindExternalAccount(ticketCode: string, user: AuthUser, username: string, password: string) {
    this.assertRateLimit('bind-external', String(user.id), 5, 15 * 60_000);
    const row = await this.requireUsableTicket(ticketCode);
    this.assertStaffApp(user);
    if (
      row.purpose !== WebLoginTicketPurpose.EXTERNAL_GATEWAY ||
      row.status !== WebLoginTicketStatus.SCANNED ||
      row.scannedByUserId !== user.id
    ) {
      throw new BadRequestException('这次扫码已失效，请让电脑刷新后重试');
    }
    await this.authService.requireExternalAccessUser(user.id, this.requiredApplication(row));
    const app = await this.externalApp(row);
    if (!user.tenantId) throw new ForbiddenException('当前账号没有所属租户，不能绑定内网应用');
    const binding = await this.externalBindings.bind(
      app,
      { id: user.id, tenantId: user.tenantId },
      username,
      password,
    );
    await this.completeConfirmation(row, user.id);
    return { ok: true as const, binding };
  }

  private async completeConfirmation(row: WebLoginTicket, userId: number) {
    const confirmedAt = new Date();
    const claimed = await this.ticketRepo.update(
      {
        id: row.id,
        status: WebLoginTicketStatus.SCANNED,
        scannedByUserId: userId,
      },
      {
        status: WebLoginTicketStatus.CONFIRMED,
        userId,
        confirmedAt,
        updatedBy: userId,
      },
    );
    if (!claimed.affected) {
      throw new BadRequestException('二维码状态已变化，请返回电脑刷新后重试');
    }
    return { ok: true as const };
  }

  /** 本人点「不是我」：立刻作废，网页那边会提示已取消 */
  async cancel(ticketCode: string, user: AuthUser) {
    this.assertRateLimit('cancel', String(user.id), 12, 5 * 60_000);
    const row = await this.findTicket(ticketCode);
    if (!row) return { ok: true as const };
    this.assertStaffApp(user);
    if (row.status === WebLoginTicketStatus.CONSUMED) {
      throw new BadRequestException('这次登录已经完成，如需退出请在网页里退出登录');
    }
    if (row.scannedByUserId !== user.id) {
      throw new ForbiddenException('只能由扫描这个二维码的员工取消');
    }
    const cancelled = await this.ticketRepo.update(
      { id: row.id, status: WebLoginTicketStatus.SCANNED, scannedByUserId: user.id },
      { status: WebLoginTicketStatus.CANCELLED, updatedBy: user.id },
    );
    if (!cancelled.affected && row.status !== WebLoginTicketStatus.CANCELLED) {
      throw new BadRequestException('二维码状态已变化，请返回电脑刷新后重试');
    }
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

  private assertBrowserBinding(row: WebLoginTicket, secret?: string) {
    if (!browserSecretMatches(secret, row.browserSecretHash)) {
      throw new UnauthorizedException('登录会话与当前浏览器不匹配，请刷新页面重新扫码');
    }
  }

  private requiredApplication(row: WebLoginTicket) {
    const request = row.oidcRequest;
    if (!request?.requiredAppId || !request.requiredAppSlug) {
      throw new BadRequestException('登录票据没有绑定目标应用，请重新打开目标系统');
    }
    return {
      appId: request.requiredAppId,
      appSlug: request.requiredAppName || request.requiredAppSlug,
    };
  }

  private async externalApp(row: WebLoginTicket) {
    const required = this.requiredApplication(row);
    const app = await this.externalAppRepo.findOne({ where: { id: required.appId, enabled: true } });
    if (!app) throw new ForbiddenException('这个内网应用已停用');
    return app;
  }

  private async bindOidcRequestToApplication(request: OidcLoginRequest): Promise<OidcLoginRequest> {
    let hostname = '';
    try {
      hostname = new URL(request.redirectUri).hostname.toLowerCase();
    } catch {
      throw new BadRequestException('OIDC 回调地址无效');
    }
    const app = await this.externalAppRepo.findOne({
      where: { publicHostname: hostname, enabled: true },
    });
    if (!app) {
      throw new ForbiddenException('该回调域名没有对应的已启用内网应用');
    }
    return {
      ...request,
      requiredAppId: app.id,
      requiredAppSlug: app.slug,
      requiredAppName: app.name,
      requiredAppHostname: app.publicHostname,
    };
  }

  /** 轻量进程级限流；数据库侧另限制每个来源一分钟内最多创建六张票据。 */
  private assertRateLimit(bucket: string, identity: string, limit: number, windowMs: number) {
    const key = `${bucket}:${identity}`;
    const now = Date.now();
    const current = this.rateWindows.get(key);
    if (!current || current.resetAt <= now) {
      this.rateWindows.set(key, { count: 1, resetAt: now + windowMs });
      if (this.rateWindows.size > 10_000) {
        for (const [entryKey, value] of this.rateWindows) {
          if (value.resetAt <= now) this.rateWindows.delete(entryKey);
        }
        while (this.rateWindows.size > 9_000) {
          const oldest = this.rateWindows.keys().next().value as string | undefined;
          if (!oldest) break;
          this.rateWindows.delete(oldest);
        }
      }
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new HttpException('请求过于频繁，请稍后再试', 429);
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
