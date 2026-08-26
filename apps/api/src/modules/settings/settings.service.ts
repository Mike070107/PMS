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
  type OwnerPhoneAutoMatchSetting,
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

  async getSettings(user: AuthUser): Promise<TenantSettings> {
    const tenantId = this.requireTenant(user);
    return this.getSettingsByTenant(tenantId);
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
    };
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
    return this.getSettingsByTenant(tenantId);
  }

  /** 定时任务与工单查询共用，保证所有入口使用同一租户口径。 */
  async getAutoReviewHoursByTenant(tenantId: number): Promise<number> {
    const row = await this.configRepo.findOne({
      where: { tenantId, key: TENANT_SETTING_KEYS.AUTO_REVIEW_HOURS },
    });
    return this.normalizeAutoReviewSetting(row?.value).hours;
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
