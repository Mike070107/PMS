import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';
import { ResolvedAccess } from '../access/access.service';
import { CollectionSmsLogService, type SmsLogRow } from '../settings/collection-sms-log.service';
import { CollectionSmsService } from '../settings/collection-sms.service';
import { renderSmsContent, sendAliyunSms, smsSegments } from '../settings/collection-sms.sender';
import { MisFeesService } from './mis-fees.service';

interface SnapshotNotice {
  houseKey: string;
  address: string;
  ownerName?: string;
  amountCents: number;
  bills: Array<{ period: string }>;
}

/**
 * 住宅催缴短信发送。
 *
 * 号码来自 MIS（后端专用解析，不经前端）；凭据来自设置里的加密配置；
 * 逐户发送、逐户落库，失败不阻断其他户。
 */
@Injectable()
export class MisCollectionSmsService {
  constructor(
    @InjectRepository(MisCollectionBatch)
    private readonly batchRepo: Repository<MisCollectionBatch>,
    private readonly mis: MisFeesService,
    private readonly settings: CollectionSmsService,
    private readonly log: CollectionSmsLogService,
  ) {}

  private periodText(bills: Array<{ period: string }>): string {
    const list = bills.map((b) => String(b.period || '')).filter((p) => /^\d{6}$/.test(p)).sort();
    if (!list.length) return '';
    const fmt = (p: string) => `${p.slice(0, 4)}.${p.slice(4)}`;
    const first = fmt(list[0]);
    const last = fmt(list[list.length - 1]);
    return first === last ? first : `${first}-${last}`;
  }

  async sendBatch(id: number, user: AuthUser, access?: ResolvedAccess, body?: { real?: boolean }) {
    const tenantId = user.tenantId;
    if (!tenantId) throw new BadRequestException('请先选择公司');

    const batch = await this.batchRepo.findOne({ where: { id, tenantId } });
    if (!batch) throw new NotFoundException('批次不存在');
    if (batch.purpose !== 'sms') throw new BadRequestException('该批次是纸质通知批次，不能发送短信');

    const snapshot = batch.snapshot as { notices?: SnapshotNotice[]; queriedAt?: string } | null;
    const notices = Array.isArray(snapshot?.notices) ? snapshot!.notices! : [];
    if (!notices.length) throw new BadRequestException('批次快照里没有可发送的住户');

    await this.mis.collectionDetail(id,user,access);
    if((await this.mis.activeCollectionHolds(notices.map(n=>n.houseKey),user,access)).length)throw new BadRequestException("该批次包含冻结住户，请重新预览生成批次；未发送短信");
    const readiness = await this.settings.readiness(tenantId);
    if (!readiness.configured || !readiness.enabled) throw new BadRequestException(readiness.reason);

    const config = await this.settings.get(user);
    const credentials = await this.settings.credentials(tenantId);
    const phones = await this.mis.contactPhones(notices.map((n) => n.houseKey), user, access);
    // 安全默认：只有调用方显式 real:true 且环境没有强制演练时才真发。
    const dryRun = body?.real !== true || process.env.SMS_DRY_RUN === 'true';
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

    const rows: SmsLogRow[] = [];
    for (const notice of notices) {
      const phone = phones.get(notice.houseKey);
      const content = renderSmsContent(config.templateContent, {
        date,
        address: notice.address,
        period: this.periodText(notice.bills),
        amount: (notice.amountCents / 100).toFixed(2),
      });
      if (!phone) {
        rows.push({
          houseKey: notice.houseKey,
          phoneTail: '—',
          content,
          segmentCount: smsSegments(content),
          status: 'failed',
          error: '无有效手机号',
        });
        continue;
      }
      const result = await sendAliyunSms(
        {
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          phone,
          signName: config.signName,
          templateCode: config.templateCode,
          templateParam: {
            date,
            address: notice.address,
            period: this.periodText(notice.bills),
            amount: (notice.amountCents / 100).toFixed(2),
          },
        },
        { dryRun },
      );
      rows.push({
        houseKey: notice.houseKey,
        phoneTail: phone.slice(-4),
        content,
        segmentCount: smsSegments(content),
        status: result.ok ? (dryRun ? 'queued' : 'submitted') : 'failed',
        bizId: result.ok ? result.bizId : null,
        error: result.ok ? null : result.error,
      });
    }

    await this.log.record(tenantId, id, rows, user.id);
    const stats = await this.log.stats(tenantId, id);
    return {
      dryRun,
      sent: rows.filter((r) => r.status !== 'failed').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      skipped: rows.filter((r) => r.status === 'failed' && r.error === '无有效手机号').length,
      stats,
    };
  }
}
