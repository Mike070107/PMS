import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';
import { MisCollectionSms } from '../../entities/mis-collection-sms.entity';
import { ResolvedAccess } from '../access/access.service';
import { CollectionSmsLogService, type SmsLogRow } from '../settings/collection-sms-log.service';
import { CollectionSmsService } from '../settings/collection-sms.service';
import { renderSmsContent, sendAliyunSms, smsSegments } from '../settings/collection-sms.sender';
import { MisFeesService } from './mis-fees.service';
import { validateMisFeeRange } from './mis-fees.query';

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

  /**
   * 短信送达统计：单条聚合查询（无 N+1），按 submitted_at、空则 created_at 落时间窗；
   * houseKey 形如「管理处:S_ID:ZH_ID」，用当前授权小区的管理处前缀过滤 communityId。
   */
  async statsRange(q: { from: string; to: string; communityId?: number }, user: AuthUser, access?: ResolvedAccess) {
    if (!user.tenantId) throw new BadRequestException('请先选择公司');
    validateMisFeeRange({ paidFrom: q.from, paidTo: q.to });
    const empty = { total: 0, submitted: 0, delivered: 0, failed: 0, queued: 0, deliveredRate: null as number | null, segments: 0 };
    const communities = await this.mis.collectionCommunities(q.communityId, user, access);
    if (!communities.length) return empty;
    const offices = [...new Set(communities.flatMap((c) => c.offices))];
    if (!offices.length) return empty;
    const start = new Date(`${q.from}T00:00:00+08:00`);
    const end = new Date(new Date(`${q.to}T00:00:00+08:00`).getTime() + 86400000);
    const qb = this.batchRepo.manager
      .getRepository(MisCollectionSms)
      .createQueryBuilder('s')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE s.status='submitted')", 'submitted')
      .addSelect("COUNT(*) FILTER (WHERE s.status='delivered')", 'delivered')
      .addSelect("COUNT(*) FILTER (WHERE s.status='failed')", 'failed')
      .addSelect("COUNT(*) FILTER (WHERE s.status='queued')", 'queued')
      .addSelect('COALESCE(SUM(s.segment_count),0)', 'segments')
      .where('s.tenant_id=:tenantId', { tenantId: user.tenantId })
      .andWhere('COALESCE(s.submitted_at,s.created_at)>=:from', { from: start })
      .andWhere('COALESCE(s.submitted_at,s.created_at)<:to', { to: end });
    const officeSql = offices.map((office, i) => {
      qb.setParameter(`office${i}`, `${office}:%`);
      return `s.house_key LIKE :office${i}`;
    });
    qb.andWhere(`(${officeSql.join(' OR ')})`);
    const raw: any = (await qb.getRawOne()) || {};
    const num = (value: unknown) => { const n = Number(value ?? 0); return Number.isSafeInteger(n) && n >= 0 ? n : 0; };
    const total = num(raw.total), submitted = num(raw.submitted), delivered = num(raw.delivered), failed = num(raw.failed), queued = num(raw.queued), segments = num(raw.segments);
    if (!total) return empty;
    const attempted = submitted + delivered + failed;
    return { total, submitted, delivered, failed, queued, segments, deliveredRate: attempted ? Math.round((delivered / attempted) * 10000) / 100 : null };
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
