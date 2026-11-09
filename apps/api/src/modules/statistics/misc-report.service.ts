import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { ReliefQueryDto, SignoffQueryDto } from './dto';
import {
  MISC_REPORT_UNAVAILABLE_MESSAGE,
  SIGNOFF_STATUSES,
  type SignoffStatus,
} from './misc-report.util';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
  STATISTICS_OFFICE_NAMES,
  type StatisticsOffice,
} from './statistics.util';
import { validateCollectionDateRange } from './collection.util';

const ADDRESS_SQL = `CONCAT(COALESCE(b.road,''),
  CASE WHEN COALESCE(b.lane,'') <> '' THEN CONCAT(b.lane,'弄') ELSE '' END,
  CASE WHEN COALESCE(b.building_no,'') <> '' THEN CONCAT(b.building_no,'号') ELSE '' END,
  COALESCE(rm.room_no,''))`;

interface MiscMirrorState {
  available: boolean;
  dataAsOf: string | null;
}

/**
 * P4-A 统计报表：减免情况统计 /signoffs 签报情况统计。
 *
 * 数据来自 P4-A 新增镜像表 mis_mirror_relief / mis_mirror_signoff（以及 owner→room→building 取地址）。
 * 是否可用以 mis_sync_state 中对应 source_table 的成功同步记录为准（未同步 → available:false + message）。
 * 面积/金额：金额整数分；日期以 YYYY-MM-DD 返回；范围左闭右开。
 */
@Injectable()
export class MiscReportService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/relief：减免情况统计。 */
  async relief(query: ReliefQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.validateRange(query.dateFrom, query.dateTo);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      keyword: query.keyword ?? null,
      limit,
      offset,
    };
    const state = await this.miscMirrorState(tenantId, 'relief');
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    if (!state.available) {
      return {
        ...base, rows: [], totals: null, count: null, available: false, message: MISC_REPORT_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], totals: { count: 0, oldReceivableCents: 0, receivableCents: 0, reliefCents: 0 },
        count: 0, available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`COALESCE(s.office_code, b.office_code) IN (${selected.map((office) => add(office.officeCode)).join(',')})`];
    if (query.dateFrom) where.push(`r.relief_date >= ${add(query.dateFrom)}::date`);
    if (query.dateTo) where.push(`r.relief_date < (${add(query.dateTo)}::date + INTERVAL '1 day')`);
    if (query.feeCodes?.length) where.push(`r.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.keyword?.trim()) {
      const pattern = add(`%${query.keyword.trim()}%`);
      where.push(`(COALESCE(r.doc_no,'') ILIKE ${pattern} OR ${ADDRESS_SQL} ILIKE ${pattern}
        OR COALESCE(o.name,'') ILIKE ${pattern} OR COALESCE(NULLIF(r.fee_name,''),fi.fee_name,'') ILIKE ${pattern})`);
    }
    const whereSql = where.join(' AND ');
    const totalsRaw: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "count",
              COALESCE(SUM(r.old_receivable_cents),0)::bigint AS "oldReceivableCents",
              COALESCE(SUM(r.receivable_cents),0)::bigint AS "receivableCents",
              COALESCE(SUM(r.relief_cents),0)::bigint AS "reliefCents"
         FROM mis_mirror_relief r
         LEFT JOIN mis_mirror_signoff s ON s.doc_no = r.doc_no
         LEFT JOIN mis_mirror_owner o ON o.zh_id = r.zh_id
         LEFT JOIN mis_mirror_room rm ON rm.s_id = o.s_id
         LEFT JOIN mis_mirror_building b ON b.l_id = rm.l_id
         LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = r.fee_code
        WHERE ${whereSql}`,
      params,
    );
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const raw: any[] = await this.dataSource.query(
      `SELECT r.id, r.doc_no AS "docNo",
              COALESCE(s.office_code, b.office_code) AS "officeCode",
              r.zh_id AS "zhId", ${ADDRESS_SQL} AS "address", o.name AS "ownerName",
              r.fee_code AS "feeCode",
              COALESCE(NULLIF(r.fee_name,''), fi.fee_name) AS "feeName",
              r.old_receivable_cents::bigint AS "oldReceivableCents",
              r.receivable_cents::bigint AS "receivableCents",
              r.relief_cents::bigint AS "reliefCents",
              to_char(r.relief_start_date,'YYYY-MM-DD') AS "reliefStartDate",
              to_char(r.relief_end_date,'YYYY-MM-DD') AS "reliefEndDate",
              to_char(r.relief_date,'YYYY-MM-DD') AS "reliefDate",
              r.method
         FROM mis_mirror_relief r
         LEFT JOIN mis_mirror_signoff s ON s.doc_no = r.doc_no
         LEFT JOIN mis_mirror_owner o ON o.zh_id = r.zh_id
         LEFT JOIN mis_mirror_room rm ON rm.s_id = o.s_id
         LEFT JOIN mis_mirror_building b ON b.l_id = rm.l_id
         LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = r.fee_code
        WHERE ${whereSql}
        ORDER BY r.relief_date DESC NULLS LAST, r.id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? null : String(row.officeCode);
      return {
        id: Number(row.id),
        docNo: row.docNo == null ? null : String(row.docNo),
        officeCode,
        officeName: officeCode == null ? null : (STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`),
        zhId: row.zhId == null ? null : Number(row.zhId),
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        feeName: row.feeName == null ? null : String(row.feeName),
        oldReceivableCents: Number(row.oldReceivableCents || 0),
        receivableCents: Number(row.receivableCents || 0),
        reliefCents: Number(row.reliefCents || 0),
        reliefStartDate: row.reliefStartDate == null ? null : String(row.reliefStartDate),
        reliefEndDate: row.reliefEndDate == null ? null : String(row.reliefEndDate),
        reliefDate: row.reliefDate == null ? null : String(row.reliefDate),
        method: row.method == null ? null : String(row.method),
      };
    });
    const totalsRow = totalsRaw[0] ?? {};
    const count = Number(totalsRow.count || 0);
    return {
      ...base,
      rows,
      totals: {
        count,
        oldReceivableCents: Number(totalsRow.oldReceivableCents || 0),
        receivableCents: Number(totalsRow.receivableCents || 0),
        reliefCents: Number(totalsRow.reliefCents || 0),
      },
      count,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/signoffs：签报情况统计（按拟稿日期区间；status 区分有效/作废/未结束）。 */
  async signoffs(query: SignoffQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.validateRange(query.dateFrom, query.dateTo);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const status: SignoffStatus = query.status ?? 'all';
    if (!SIGNOFF_STATUSES.includes(status)) throw new BadRequestException('status 不合法');
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      officeCodes: selected.map((office) => office.officeCode),
      types: query.types ?? null,
      status,
      keyword: query.keyword ?? null,
      limit,
      offset,
    };
    const state = await this.miscMirrorState(tenantId, 'signoff');
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    if (!state.available) {
      return {
        ...base, rows: [], totals: null, count: null, available: false, message: MISC_REPORT_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], totals: { count: 0, voidedCount: 0, endedCount: 0, adjustAmountCents: 0 },
        count: 0, available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`s.office_code IN (${selected.map((office) => add(office.officeCode)).join(',')})`];
    if (query.dateFrom) where.push(`s.draft_date >= ${add(query.dateFrom)}::date`);
    if (query.dateTo) where.push(`s.draft_date < (${add(query.dateTo)}::date + INTERVAL '1 day')`);
    if (query.types?.length) where.push(`s.type IN (${query.types.map(add).join(',')})`);
    if (status === 'effective') where.push('s.voided = false AND s.ended = true');
    else if (status === 'voided') where.push('s.voided = true');
    else if (status === 'open') where.push('s.voided = false AND s.ended = false');
    if (query.keyword?.trim()) {
      const pattern = add(`%${query.keyword.trim()}%`);
      where.push(`(COALESCE(s.doc_no,'') ILIKE ${pattern} OR COALESCE(s.title,'') ILIKE ${pattern}
        OR COALESCE(s.type,'') ILIKE ${pattern} OR ${ADDRESS_SQL} ILIKE ${pattern} OR COALESCE(o.name,'') ILIKE ${pattern})`);
    }
    const whereSql = where.join(' AND ');
    const totalsRaw: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "count",
              COUNT(*) FILTER (WHERE s.voided)::int AS "voidedCount",
              COUNT(*) FILTER (WHERE s.ended)::int AS "endedCount",
              COALESCE(SUM(s.adjust_amount_cents),0)::bigint AS "adjustAmountCents"
         FROM mis_mirror_signoff s
         LEFT JOIN mis_mirror_owner o ON o.zh_id = s.zh_id
         LEFT JOIN mis_mirror_room rm ON rm.s_id = o.s_id
         LEFT JOIN mis_mirror_building b ON b.l_id = rm.l_id
        WHERE ${whereSql}`,
      params,
    );
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const raw: any[] = await this.dataSource.query(
      `SELECT s.id, s.doc_no AS "docNo", s.title, s.type, s.detail,
              s.office_code AS "officeCode", s.zh_id AS "zhId",
              ${ADDRESS_SQL} AS "address", o.name AS "ownerName",
              to_char(s.draft_date,'YYYY-MM-DD') AS "draftDate",
              to_char(s.approve_date,'YYYY-MM-DD') AS "approveDate",
              s.result, s.voided, s.ended,
              s.adjust_amount_cents::bigint AS "adjustAmountCents", s.fee_code AS "feeCode"
         FROM mis_mirror_signoff s
         LEFT JOIN mis_mirror_owner o ON o.zh_id = s.zh_id
         LEFT JOIN mis_mirror_room rm ON rm.s_id = o.s_id
         LEFT JOIN mis_mirror_building b ON b.l_id = rm.l_id
        WHERE ${whereSql}
        ORDER BY s.draft_date DESC NULLS LAST, s.id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? null : String(row.officeCode);
      return {
        id: Number(row.id),
        docNo: row.docNo == null ? null : String(row.docNo),
        title: row.title == null ? null : String(row.title),
        type: row.type == null ? null : String(row.type),
        detail: row.detail == null ? null : String(row.detail),
        officeCode,
        officeName: officeCode == null ? null : (STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`),
        zhId: row.zhId == null ? null : Number(row.zhId),
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        draftDate: row.draftDate == null ? null : String(row.draftDate),
        approveDate: row.approveDate == null ? null : String(row.approveDate),
        result: row.result == null ? null : String(row.result),
        voided: Boolean(row.voided),
        ended: Boolean(row.ended),
        adjustAmountCents: Number(row.adjustAmountCents || 0),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
      };
    });
    const totalsRow = totalsRaw[0] ?? {};
    const count = Number(totalsRow.count || 0);
    return {
      ...base,
      rows,
      totals: {
        count,
        voidedCount: Number(totalsRow.voidedCount || 0),
        endedCount: Number(totalsRow.endedCount || 0),
        adjustAmountCents: Number(totalsRow.adjustAmountCents || 0),
      },
      count,
      available: true,
      message: null,
    };
  }

  private validateRange(dateFrom?: string, dateTo?: string) {
    if (dateFrom && dateTo) validateCollectionDateRange(dateFrom, dateTo);
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }

  private async loadCommunities(tenantId: number): Promise<Array<{ id: number; name: string }>> {
    const rows = await this.communityRepo.find({ where: { tenantId } }).catch(() => []);
    return rows.map((community) => ({ id: community.id, name: community.name }));
  }

  private async selectedOffices(
    tenantId: number,
    access: ResolvedAccess | undefined,
    requested?: string[],
  ): Promise<StatisticsOffice[]> {
    const communities = await this.loadCommunities(tenantId);
    return filterRequestedOffices(resolveStatisticsOffices(communities, scopeCommunityIds(access)), requested);
  }

  /** 以 mis_sync_state 的成功同步记录判断该镜像是否可用。 */
  private async miscMirrorState(tenantId: number, source: string): Promise<MiscMirrorState> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table=$2 LIMIT 1`,
        [tenantId, source],
      )
      .catch(() => []);
    const value = rows[0]?.last_success_at ?? null;
    return {
      available: Boolean(value),
      dataAsOf: value ? new Date(value).toISOString() : null,
    };
  }
}
