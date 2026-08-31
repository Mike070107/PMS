import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import { House, TenantConfig, User } from '../../entities';
import { UpdateTenantSettingsDto } from './dto';
import {
  DEFAULT_TENANT_SETTINGS,
  TENANT_SETTING_KEYS,
  type AutoReviewSetting,
  type DispatchEscalationSetting,
  type OwnerPhoneAutoMatchSetting,
  type AiAssistSetting,
  type WxServiceAccountSetting,
  type TenantSettings,
  type WxSubscribeTemplatesSetting,
} from './settings.constants';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(TenantConfig)
    private readonly configRepo: Repository<TenantConfig>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
  ) {}

  /** 给接口用：密钥字段脱敏后再返回 */
  async getSettings(user: AuthUser): Promise<TenantSettings> {
    const tenantId = this.requireTenant(user);
    const settings = await this.getSettingsByTenant(tenantId);
    return {
      ...settings,
      wxServiceAccount: {
        ...settings.wxServiceAccount,
        appSecret: this.maskSecret(settings.wxServiceAccount.appSecret),
      },
      aiAssist: {
        ...settings.aiAssist,
        apiKey: this.maskSecret(settings.aiAssist.apiKey),
      },
    };
  }

  /** 内部用：小程序侧要按租户判断开关，拿不到 AuthUser 的场景走这个 */
  async getSettingsByTenant(tenantId: number): Promise<TenantSettings> {
    const rows = await this.configRepo.find({ where: { tenantId } });
    const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
    return {
      ownerPhoneAutoMatch: {
        ...DEFAULT_TENANT_SETTINGS.ownerPhoneAutoMatch,
        ...((byKey.get(TENANT_SETTING_KEYS.OWNER_PHONE_AUTO_MATCH) ??
          {}) as Partial<OwnerPhoneAutoMatchSetting>),
      },
      wxSubscribeTemplates: {
        ...DEFAULT_TENANT_SETTINGS.wxSubscribeTemplates,
        ...((byKey.get(TENANT_SETTING_KEYS.WX_SUBSCRIBE_TEMPLATES) ??
          {}) as Partial<WxSubscribeTemplatesSetting>),
      },
      autoReview: this.normalizeAutoReviewSetting(
        byKey.get(TENANT_SETTING_KEYS.AUTO_REVIEW_HOURS),
      ),
      dispatchEscalation: this.normalizeEscalationSetting(
        byKey.get(TENANT_SETTING_KEYS.DISPATCH_ESCALATION),
      ),
      wxServiceAccount: {
        ...DEFAULT_TENANT_SETTINGS.wxServiceAccount,
        ...((byKey.get(TENANT_SETTING_KEYS.WX_SERVICE_ACCOUNT) ??
          {}) as Partial<WxServiceAccountSetting>),
      },
      aiAssist: {
        ...DEFAULT_TENANT_SETTINGS.aiAssist,
        ...((byKey.get(TENANT_SETTING_KEYS.AI_ASSIST) ?? {}) as Partial<AiAssistSetting>),
      },
    };
  }

  /**
   * 大模型的**明文**配置，只给服务端内部调接口用。
   * 对外的 getSettings 一律走脱敏版，apiKey 绝不能从接口漏出去。
   */
  async getAiAssistRaw(tenantId: number): Promise<AiAssistSetting> {
    return (await this.getSettingsByTenant(tenantId)).aiAssist;
  }

  /**
   * 服务号的**明文**凭据，只给服务端内部调微信接口用。
   * 对外的 getSettings 一律走脱敏版（见下），密钥绝不能从接口漏出去。
   */
  async getServiceAccountRaw(tenantId: number): Promise<WxServiceAccountSetting> {
    return (await this.getSettingsByTenant(tenantId)).wxServiceAccount;
  }

  /** AppSecret 只回显后 4 位：管理员能确认「填过了、是这一条」，但拿不走 */
  private maskSecret(secret: string): string {
    if (!secret) return '';
    return secret.length > 4 ? `••••••••${secret.slice(-4)}` : '••••••••';
  }

  async getPhoneMatchStat(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const [ownersWithPhoneAndHouse, housesTotal] = await Promise.all([
      this.userRepo
        .createQueryBuilder("u")
        .where("u.tenant_id = :tenantId", { tenantId })
        .andWhere("u.role = :role", { role: UserRole.OWNER })
        .andWhere("u.phone IS NOT NULL")
        .andWhere("u.house_id IS NOT NULL")
        .getCount(),
      this.houseRepo.count({ where: { tenantId } }),
    ]);
    return { ownersWithPhoneAndHouse, housesTotal };
  }

  async updateSettings(dto: UpdateTenantSettingsDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    if (dto.ownerPhoneAutoMatch) {
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.OWNER_PHONE_AUTO_MATCH,
        { enabled: dto.ownerPhoneAutoMatch.enabled },
        user.id,
      );
    }
    if (dto.wxSubscribeTemplates) {
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.WX_SUBSCRIBE_TEMPLATES,
        {
          orderDispatched: dto.wxSubscribeTemplates.orderDispatched?.trim() ?? '',
          orderReview: dto.wxSubscribeTemplates.orderReview?.trim() ?? '',
          orderAssigned: dto.wxSubscribeTemplates.orderAssigned?.trim() ?? '',
          orderOverdue: dto.wxSubscribeTemplates.orderOverdue?.trim() ?? '',
          orderUrge: dto.wxSubscribeTemplates.orderUrge?.trim() ?? '',
        },
        user.id,
      );
    }
    if (dto.autoReview) {
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.AUTO_REVIEW_HOURS,
        { hours: dto.autoReview.hours },
        user.id,
      );
    }
    if (dto.dispatchEscalation) {
      const incoming = dto.dispatchEscalation;
      // 没传的字段保持原样：老后台只发 acceptMinutes，不能顺手把时段清成默认值
      const current = (await this.getSettingsByTenant(tenantId)).dispatchEscalation;
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.DISPATCH_ESCALATION,
        {
          // 老口径 acceptMinutes=0 就是关闭，继续认
          enabled: incoming.enabled ?? incoming.acceptMinutes !== 0,
          acceptMinutes: incoming.acceptMinutes || current.acceptMinutes,
          startAt: incoming.startAt ?? current.startAt,
          endAt: incoming.endAt ?? current.endAt,
        },
        user.id,
      );
    }
    if (dto.wxServiceAccount) {
      const current = await this.getServiceAccountRaw(tenantId);
      const nextAppId = dto.wxServiceAccount.appId?.trim() ?? current.appId;
      // 留空 = 保持不变。页面上回显的是脱敏串，原样提交回来也当没改 ——
      // 不这么判的话，管理员改个模板 ID 顺手保存，密钥就被那串圆点覆盖了
      const incoming = dto.wxServiceAccount.appSecret?.trim() ?? '';
      const keepSecret = !incoming || incoming.startsWith('••');
      // 换了 AppID 还留着旧 secret 必然对不上，直接清掉，逼管理员重填
      const nextSecret = keepSecret
        ? nextAppId === current.appId
          ? current.appSecret
          : ''
        : incoming;
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.WX_SERVICE_ACCOUNT,
        {
          appId: nextAppId,
          appSecret: nextSecret,
          templateOrderAssigned:
            dto.wxServiceAccount.templateOrderAssigned?.trim() ??
            current.templateOrderAssigned,
          enabled: dto.wxServiceAccount.enabled ?? current.enabled,
        },
        user.id,
      );
    }
    if (dto.aiAssist) {
      const current = await this.getAiAssistRaw(tenantId);
      const nextBaseUrl = dto.aiAssist.baseUrl?.trim().replace(/\/+$/, '') || current.baseUrl;
      // 留空 / 原样交回脱敏串 = 保持不变。页面回显的是圆点串，
      // 管理员改个模型名顺手保存，密钥不能被那串圆点覆盖
      const incoming = dto.aiAssist.apiKey?.trim() ?? '';
      const keepKey = !incoming || incoming.startsWith('••');
      // 换了服务商地址还留着旧 key 必然认证失败，直接清掉，逼管理员重填
      const nextKey = keepKey ? (nextBaseUrl === current.baseUrl ? current.apiKey : '') : incoming;
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.AI_ASSIST,
        {
          enabled: dto.aiAssist.enabled ?? current.enabled,
          baseUrl: nextBaseUrl,
          model: dto.aiAssist.model?.trim() || current.model,
          apiKey: nextKey,
          timeoutMs: dto.aiAssist.timeoutMs ?? current.timeoutMs,
        },
        user.id,
      );
    }
    /**
     * 保存完回**脱敏**版，不能走 getSettingsByTenant。
     *
     * 那个是给服务端内部用的明文版：管理员点一次保存，服务号 AppSecret 和大模型
     * API Key 就原样出现在接口响应里 —— 浏览器 network 面板看得到、前端日志和
     * 网关访问日志都可能留下（2026-09-01 配置大模型时发现，服务号那份一直如此）。
     * 页面本来也只认脱敏串（原样交回 = 不改），回明文没有任何好处。
     */
    return this.getSettings(user);
  }

  /** 定时任务与工单查询共用，保证所有入口使用同一租户口径。 */
  async getAutoReviewHoursByTenant(tenantId: number): Promise<number> {
    const row = await this.configRepo.findOne({
      where: { tenantId, key: TENANT_SETTING_KEYS.AUTO_REVIEW_HOURS },
    });
    return this.normalizeAutoReviewSetting(row?.value).hours;
  }

  /**
   * 时限 5～1440 分钟，时段 HH:mm，越界一律退回默认值。
   * 老数据没有 enabled/startAt/endAt：enabled 按当时的口径（acceptMinutes=0 即关闭）推断，
   * 时段用默认的 8:00~20:00。
   */
  private normalizeEscalationSetting(value: unknown): DispatchEscalationSetting {
    const fallback = DEFAULT_TENANT_SETTINGS.dispatchEscalation;
    const raw = (value ?? {}) as Partial<DispatchEscalationSetting>;
    const minutes = Number(raw.acceptMinutes);
    const okMinutes = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
    const clock = (v: unknown, dft: string) =>
      typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : dft;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : minutes !== 0,
      acceptMinutes: okMinutes ? minutes : fallback.acceptMinutes,
      startAt: clock(raw.startAt, fallback.startAt),
      endAt: clock(raw.endAt, fallback.endAt),
    };
  }

  /**
   * 现在这一刻在不在催办时段里。startAt=endAt 视为全天。
   * 跨零点（20:00~08:00）走「或」，不跨的走「且」。
   */
  static withinWindow(setting: DispatchEscalationSetting, at: Date = new Date()): boolean {
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const start = toMin(setting.startAt);
    const end = toMin(setting.endAt);
    if (start === end) return true;
    const now = at.getHours() * 60 + at.getMinutes();
    return start < end ? now >= start && now < end : now >= start || now < end;
  }

  private normalizeAutoReviewSetting(value: unknown): AutoReviewSetting {
    const raw = Number((value as Partial<AutoReviewSetting> | null)?.hours);
    const hours = Number.isInteger(raw) && raw >= 1 && raw <= 720
      ? raw
      : DEFAULT_TENANT_SETTINGS.autoReview.hours;
    return { hours };
  }

  private async upsert(
    tenantId: number,
    key: string,
    value: Record<string, unknown>,
    operatorId: number,
  ) {
    const existing = await this.configRepo.findOne({ where: { tenantId, key } });
    if (existing) {
      existing.value = value;
      existing.updatedBy = operatorId;
      await this.configRepo.save(existing);
      return;
    }
    await this.configRepo.save(
      this.configRepo.create({
        tenantId,
        key,
        value,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    );
  }

  private requireTenant(user: AuthUser): number {
    if (user.tenantId) return user.tenantId;
    if (user.role === UserRole.SUPERADMIN) {
      throw new ForbiddenException('平台管理员请指定具体物业公司后再改设置');
    }
    throw new ForbiddenException('tenant scope is required');
  }
}
