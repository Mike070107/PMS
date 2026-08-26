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
    };
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
      await this.upsert(
        tenantId,
        TENANT_SETTING_KEYS.DISPATCH_ESCALATION,
        { acceptMinutes: dto.dispatchEscalation.acceptMinutes },
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
    return this.getSettingsByTenant(tenantId);
  }

  /** 定时任务与工单查询共用，保证所有入口使用同一租户口径。 */
  async getAutoReviewHoursByTenant(tenantId: number): Promise<number> {
    const row = await this.configRepo.findOne({
      where: { tenantId, key: TENANT_SETTING_KEYS.AUTO_REVIEW_HOURS },
    });
    return this.normalizeAutoReviewSetting(row?.value).hours;
  }

  /** 0 = 关闭；其余允许 5～1440 分钟，超出范围一律退回默认值 */
  private normalizeEscalationSetting(value: unknown): DispatchEscalationSetting {
    const raw = Number(
      (value as Partial<DispatchEscalationSetting> | null)?.acceptMinutes,
    );
    if (raw === 0) return { acceptMinutes: 0 };
    const ok = Number.isInteger(raw) && raw >= 5 && raw <= 1440;
    return {
      acceptMinutes: ok ? raw : DEFAULT_TENANT_SETTINGS.dispatchEscalation.acceptMinutes,
    };
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
