import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole, UserStatus } from '../../common/enums';
import { Tenant, User } from '../../entities';

export interface JwtPayload {
  sub: number;
  tenantId: number | null;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'change-me-in-prod'),
      passReqToCallback: true,
    });
  }

  /**
   * token 里的 tenantId / role 只是签发那一刻的快照。业主是「先微信登录（无租户）
   * 再入驻」，入驻时才把租户写进库里；如果继续信任老 token，报修类型、我的工单
   * 这类按租户取数的接口会一直 403（表现为「随手拍」页反过来叫人去认证房屋）。
   * 所以每次请求都以库里的归属为准，token 只用来证明「你是谁」。
   *
   * 租户切换（平台代操作）：superadmin 请求带 x-acting-tenant-id 头时，
   * 本次请求以该公司身份运作（tenantId 被替换），全后台现成接口直接可用。
   * 进入动作由 /platform/tenants/:id/enter 记审计；身份仍是 superadmin，
   * PermissionsGuard 对其直通。非 superadmin 带这个头一律忽略。
   */
  async validate(req: Request, payload: JwtPayload): Promise<AuthUser> {
    const user = await this.userRepo.findOne({
      where: { id: payload.sub },
      select: ['id', 'tenantId', 'role', 'status'],
    });
    if (!user) throw new UnauthorizedException('用户不存在或已删除');
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('账号已停用');
    }

    let tenantId = user.tenantId;
    if (user.role === UserRole.SUPERADMIN) {
      const raw = req.headers['x-acting-tenant-id'];
      const actingId = Number(Array.isArray(raw) ? raw[0] : raw);
      if (Number.isInteger(actingId) && actingId > 0) {
        const tenant = await this.tenantRepo.findOne({ where: { id: actingId } });
        if (!tenant) throw new UnauthorizedException('目标公司不存在');
        tenantId = tenant.id;
      }
    } else if (tenantId) {
      // SaaS 服务闸门：公司被平台停用或服务到期，全员（含小程序业主/员工）直接拦，
      // superadmin 不受限 —— 平台要能进到期公司里续期、导数据。
      const tenant = await this.tenantRepo.findOne({
        where: { id: tenantId },
        select: ['id', 'enabled', 'expiresAt'],
      });
      if (!tenant || !tenant.enabled) {
        throw new UnauthorizedException('物业公司账号已停用，请联系平台');
      }
      if (this.tenantExpired(tenant.expiresAt)) {
        throw new UnauthorizedException('物业公司服务已到期，请联系平台续期');
      }
    }

    // 管理处视角：只收窄数据范围不放大权限，所以任何后台身份都允许携带；
    // 值是否有效（属于本公司、在自己范围内）由 AccessService 校验，无效即忽略。
    const rawOffice = req.headers['x-acting-office-id'];
    const actingOfficeId = Number(Array.isArray(rawOffice) ? rawOffice[0] : rawOffice);
    return {
      id: user.id,
      tenantId,
      role: user.role,
      actingOfficeId:
        Number.isInteger(actingOfficeId) && actingOfficeId > 0 ? actingOfficeId : null,
    };
  }

  /** expires_at 含当天：2026-12-31 到期则 2027-01-01 起拦截（按东八区自然日） */
  private tenantExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    return String(expiresAt).slice(0, 10) < today;
  }
}
