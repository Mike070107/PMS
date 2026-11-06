import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantConfig } from '../../entities/tenant-config.entity';
import { AuthUser } from '../../common/current-user.decorator';

/** 催收跟进规则：页面上可改，改完即时生效。 */
export const DEFAULT_FOLLOWUP_RULE = {
  amountCents: 180000, // ¥1,800
  inactiveDays: 7,
  enabled: true,
};
export type FollowupRule = typeof DEFAULT_FOLLOWUP_RULE;

const KEY = 'collection_followup_rule';

@Injectable()
export class CollectionFollowupService {
  constructor(@InjectRepository(TenantConfig) private readonly repo: Repository<TenantConfig>) {}

  private tenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('请先选择公司');
    return user.tenantId;
  }

  async get(user: AuthUser): Promise<FollowupRule> {
    const row = await this.repo.findOne({ where: { tenantId: this.tenant(user), key: KEY } });
    return { ...DEFAULT_FOLLOWUP_RULE, ...((row?.value as Partial<FollowupRule>) || {}) };
  }

  async save(patch: Partial<FollowupRule>, user: AuthUser): Promise<FollowupRule> {
    const tenantId = this.tenant(user);
    const row = await this.repo.findOne({ where: { tenantId, key: KEY } });
    const merged = { ...DEFAULT_FOLLOWUP_RULE, ...((row?.value as Partial<FollowupRule>) || {}), ...patch };
    const next: FollowupRule = {
      amountCents: Math.max(0, Math.round(Number(merged.amountCents) || 0)),
      inactiveDays: Math.min(365, Math.max(1, Math.round(Number(merged.inactiveDays) || 7))),
      enabled: merged.enabled !== false,
    };
    if (row) await this.repo.update({ id: row.id }, { value: next, updatedBy: user.id });
    else await this.repo.createQueryBuilder().insert().into(TenantConfig).values({ tenantId, key: KEY, value: next, updatedBy: user.id }).execute();
    return next;
  }
}
