import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantConfig } from '../../entities/tenant-config.entity';
import { AuthUser } from '../../common/current-user.decorator';

/** 打印通知单上可配置的文案与联系方式；不填就用这里的默认值。 */
export const DEFAULT_NOTICE_TEMPLATE = {
  orgSuffix: '物业服务中心',
  signatureSuffix: '物业管理处',
  phone: '',
  serviceHours: '8:30–17:30 · 周一至周日',
  address: '',
  bankHolder: '',
  bankName: '',
  bankAccount: '',
  payMethods: '现金 / 微信 / 支付宝 / 刷卡',
  onlineTitle: '线上缴费已开通',
  onlineText: '微信扫码进入缴费页，选房号、勾账期即可付款，实时销账，电子收据当场生成。',
  notes: [
    '扫码后请先核对房号与账期，系统按所选账期逐期销账。',
    '转账或前台缴费，款项到账后 1 个工作日内自动销账。',
    '需发票或纸质收据请到服务中心登记抬头与税号。',
  ],
  liability: '本单为欠费提醒，不作为收款凭证；缴费以收据或电子收据为准。',
  showBatchNo: true,
  showPhone: true,
};

export type NoticeTemplate = typeof DEFAULT_NOTICE_TEMPLATE;

const KEY = 'residential_notice_template';

@Injectable()
export class NoticeTemplateService {
  constructor(@InjectRepository(TenantConfig) private readonly repo: Repository<TenantConfig>) {}

  private tenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('请先选择公司');
    return user.tenantId;
  }

  async get(user: AuthUser): Promise<NoticeTemplate> {
    const row = await this.repo.findOne({ where: { tenantId: this.tenant(user), key: KEY } });
    return { ...DEFAULT_NOTICE_TEMPLATE, ...((row?.value as Partial<NoticeTemplate>) || {}) };
  }

  async save(patch: Partial<NoticeTemplate>, user: AuthUser): Promise<NoticeTemplate> {
    const tenantId = this.tenant(user);
    const row = await this.repo.findOne({ where: { tenantId, key: KEY } });
    const next = { ...DEFAULT_NOTICE_TEMPLATE, ...((row?.value as Partial<NoticeTemplate>) || {}), ...patch };
    if (Array.isArray(next.notes)) next.notes = next.notes.map((n) => String(n).trim()).filter(Boolean).slice(0, 6);
    if (row) {
      await this.repo.update({ id: row.id }, { value: next, updatedBy: user.id });
    } else {
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(TenantConfig)
        .values({ tenantId, key: KEY, value: next, updatedBy: user.id })
        .execute();
    }
    return this.get(user);
  }
}
