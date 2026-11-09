import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  buildCollectionAssessment,
  type ArrearsPrepaidGroupBy,
  type ArrearsPrepaidTab,
} from './arrears.util';
import {
  ArrearsPrepaidBillsQueryDto,
  ArrearsPrepaidDetailQueryDto,
  ArrearsPrepaidSummaryQueryDto,
  CollectionAssessmentQueryDto,
} from './dto';
import {
  collectionGroupLabel,
  validateCollectionYear,
} from './collection.util';
import {
  filterRequestedOffices,
  formatPeriodRange,
  resolveStatisticsOffices,
  type StatisticsOffice,
} from './statistics.util';

const MIRROR_UNAVAILABLE_MESSAGE =
  'MIS 镜像尚未同步或没有账单数据，请管理员先执行镜像重灌后再查看欠收/溢收报表';

interface MirrorState {
  billCount: number;
  dataAsOf: string | null;
}

interface ArrearsFilterInput {
  officeCodes?: string[];
  feeCodes?: string[];
  natures?: string[];
  paidDateTo?: string;
}

/**
 * P2-C「欠收与溢收汇总」+「收缴考核」只读报表。
 *
 * 口径（docs/statistics-p2-report-layouts.md §4.10/§4.11；暂忽略源库 ZJ_Jzrq/ZJ_TZRQ/ZJ_Bdrq）：
 * - 欠收 = refund_date IS NULL AND (paid_date IS NULL OR paid_date > paidDateTo)
 *          AND period <= asOfPeriod AND amount_cents > 0
 * - 溢收/预收 = refund_date IS NULL AND paid_date IS NOT NULL AND paid_date <= paidDateTo
 *          AND period > asOfPeriod AND amount_cents > 0
 * - 收缴考核：月应收按所属年月 period；月已收也按所属年月归属（paid_date 非空且 refund 为空）；
 *   金额/户数收缴率保留两位小数；汇总不受分页影响。
 * 未镜像时 available:false + message，不伪造 0；金额一律整数分。
 */
@Injectable()
export class ArrearsStatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/arrears-prepaid/summary：欠收/溢收按管理处或收费项目汇总。 */
  async arrearsPrepaidSummary(
    query: ArrearsPrepaidSummaryQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const groupBy: ArrearsPrepaidGroupBy = query.groupBy ?? 'office';
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      groupBy,
      asOfPeriod: query.asOfPeriod,
      paidDateTo: query.paidDateTo ?? null,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { asOfPeriod: query.asOfPeriod, paidDateTo: query.paidDateTo ?? null, groupBy, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], total: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], total: { arrearsCents: 0, arrearsRows: 0, prepaidCents: 0, prepaidRows: 0 },
        available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const context = this.buildArrearsContext(add, selected.map((office) => office.officeCode), query);
    const keyExpr = groupBy === 'office' ? 'b.office_code' : 'b.fee_code';
    const labelExpr = groupBy === 'office'
      ? 'b.office_code'
      : `COALESCE(NULLIF(MAX(fi.fee_name),''),NULLIF(MAX(b.fee_name),''),b.fee_code)`;
    const join = groupBy === 'fee' ? 'LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code' : '';
    const sql = `SELECT ${keyExpr} AS "key", ${labelExpr} AS "label",
        COALESCE(SUM(CASE WHEN ${context.arrearsCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "arrearsCents",
        COUNT(*) FILTER (WHERE ${context.arrearsCond})::int AS "arrearsRows",
        COALESCE(SUM(CASE WHEN ${context.prepaidCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidCents",
        COUNT(*) FILTER (WHERE ${context.prepaidCond})::int AS "prepaidRows"
      FROM mis_mirror_bill b
      ${join}
      WHERE ${context.where.join(' AND ')}
      GROUP BY ${keyExpr}
      ORDER BY "arrearsCents" DESC, "key" ASC`;
    const raw: any[] = await this.dataSource.query(sql, params);
    const rows = raw.map((row) => {
      const key = row.key == null ? '' : String(row.key);
      return {
        key,
        label: collectionGroupLabel(groupBy, key, row.label == null ? null : String(row.label)),
        arrearsCents: Number(row.arrearsCents || 0),
        arrearsRows: Number(row.arrearsRows || 0),
        prepaidCents: Number(row.prepaidCents || 0),
        prepaidRows: Number(row.prepaidRows || 0),
      };
    });
    const total = rows.reduce(
      (sum, row) => ({
        arrearsCents: sum.arrearsCents + row.arrearsCents,
        arrearsRows: sum.arrearsRows + row.arrearsRows,
        prepaidCents: sum.prepaidCents + row.prepaidCents,
        prepaidRows: sum.prepaidRows + row.prepaidRows,
      }),
      { arrearsCents: 0, arrearsRows: 0, prepaidCents: 0, prepaidRows: 0 },
    );
    return { ...base, rows, total, available: true, message: null };
  }

  /** GET /statistics/arrears-prepaid/detail：欠收/溢收按房屋×收费项目聚合明细。 */
  async arrearsPrepaidDetail(
    query: ArrearsPrepaidDetailQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const tab: ArrearsPrepaidTab = query.tab ?? 'arrears';
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      tab,
      asOfPeriod: query.asOfPeriod,
      paidDateTo: query.paidDateTo ?? null,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = {
      tab, asOfPeriod: query.asOfPeriod, paidDateTo: query.paidDateTo ?? null,
      filters, limit, offset, dataAsOf: state.dataAsOf,
    };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totals: null, count: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return { ...base, rows: [], totals: { amountCents: 0, rows: 0 }, count: 0, available: true, message: null };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const context = this.buildArrearsContext(add, selected.map((office) => office.officeCode), query);
    const tabCond = tab === 'prepaid' ? context.prepaidCond : context.arrearsCond;
    const where = `${context.where.join(' AND ')} AND ${tabCond}`;
    const totalsSql = `SELECT COUNT(*)::int AS "rows",
        COALESCE(SUM(g.amount_cents),0)::bigint AS "amountCents"
      FROM (
        SELECT b.s_id, b.fee_code, SUM(b.amount_cents) AS amount_cents
          FROM mis_mirror_bill b
          WHERE ${where}
          GROUP BY b.s_id, b.fee_code
      ) g`;
    const totalsRaw: any[] = await this.dataSource.query(totalsSql, params);
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const rowsSql = `SELECT b.s_id AS "sId", MAX(b.address) AS "address", MAX(b.owner_name) AS "ownerName",
        MAX(r.area_sqm)::float8 AS "areaSqm", b.fee_code AS "feeCode",
        COALESCE(NULLIF(MAX(fi.fee_name),''),NULLIF(MAX(b.fee_name),''),b.fee_code) AS "feeName",
        NULLIF(TRIM(MAX(b.nature_code)),'') AS "natureCode",
        MIN(b.period) AS "periodFrom", MAX(b.period) AS "periodTo",
        COUNT(DISTINCT b.period)::int AS "months",
        COALESCE(SUM(b.amount_cents),0)::bigint AS "amountCents"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_room r ON r.s_id = b.s_id
      LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code
      WHERE ${where}
      GROUP BY b.s_id, b.fee_code
      ORDER BY "amountCents" DESC, b.s_id, b.fee_code
      LIMIT ${limitParam} OFFSET ${offsetParam}`;
    const raw: any[] = await this.dataSource.query(rowsSql, params);
    const rows = raw.map((row) => ({
      sId: row.sId == null ? null : Number(row.sId),
      address: row.address == null ? null : String(row.address),
      ownerName: row.ownerName == null ? null : String(row.ownerName),
      areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
      feeCode: row.feeCode == null ? null : String(row.feeCode),
      feeName: row.feeName == null ? null : String(row.feeName),
      natureCode: row.natureCode == null ? null : String(row.natureCode),
      periodFrom: row.periodFrom == null ? null : String(row.periodFrom),
      periodTo: row.periodTo == null ? null : String(row.periodTo),
      periodRange: formatPeriodRange(
        row.periodFrom == null ? null : String(row.periodFrom),
        row.periodTo == null ? null : String(row.periodTo),
      ),
      months: Number(row.months || 0),
      amountCents: Number(row.amountCents || 0),
    }));
    const totalsRow = totalsRaw[0] ?? {};
    return {
      ...base,
      rows,
      totals: { amountCents: Number(totalsRow.amountCents || 0), rows: Number(totalsRow.rows || 0) },
      count: Number(totalsRow.rows || 0),
      available: true,
      message: null,
    };
  }

  /** GET /statistics/arrears-prepaid/detail/bills：房屋×费项的逐笔清单，金额=明细单元格。 */
  async arrearsPrepaidBills(
    query: ArrearsPrepaidBillsQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const tab: ArrearsPrepaidTab = query.tab ?? 'arrears';
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      tab,
      asOfPeriod: query.asOfPeriod,
      paidDateTo: query.paidDateTo ?? null,
      sId: query.sId,
      feeCode: query.feeCode,
      officeCodes: selected.map((office) => office.officeCode),
    };
    const state = await this.mirrorState(tenantId);
    const base = { tab, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totalCents: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return { ...base, rows: [], totalCents: 0, available: true, message: null };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const context = this.buildArrearsContext(add, selected.map((office) => office.officeCode), query);
    const tabCond = tab === 'prepaid' ? context.prepaidCond : context.arrearsCond;
    const sIdParam = add(query.sId);
    const feeParam = add(query.feeCode);
    const where = `${context.where.join(' AND ')} AND ${tabCond} AND b.s_id = ${sIdParam} AND b.fee_code = ${feeParam}`;
    const sql = `SELECT b.zj_id AS "zjId", b.period AS "period", b.amount_cents::bigint AS "amountCents",
        to_char(b.paid_date,'YYYY-MM-DD') AS "paidDate",
        to_char(b.refund_date,'YYYY-MM-DD') AS "refundDate"
      FROM mis_mirror_bill b
      WHERE ${where}
      ORDER BY b.period, b.zj_id`;
    const raw: any[] = await this.dataSource.query(sql, params);
    const rows = raw.map((row) => ({
      zjId: Number(row.zjId),
      period: row.period == null ? null : String(row.period),
      amountCents: Number(row.amountCents || 0),
      paidDate: row.paidDate == null ? null : String(row.paidDate),
      refundDate: row.refundDate == null ? null : String(row.refundDate),
    }));
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return { ...base, rows, totalCents, available: true, message: null };
  }

  /** GET /statistics/collection-assessment：收缴考核（行=房屋，列=12 月应收/已收）。 */
  async collectionAssessment(
    query: CollectionAssessmentQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const year = validateCollectionYear(query.year);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      year,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paidDateTo: query.paidDateTo ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { year, filters, limit, offset, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], summary: null, count: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      const empty = buildCollectionAssessment([], limit, offset);
      return { ...base, rows: empty.rows, summary: empty.summary, count: empty.count, available: true, message: null };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const yearParam = add(year);
    const where: string[] = [
      `b.office_code IN (${selected.map((office) => add(office.officeCode)).join(',')})`,
      `b.period ~ '^[0-9]{6}$'`,
      `substr(b.period,1,4)::int = ${yearParam}`,
      'b.refund_date IS NULL',
      'b.amount_cents > 0',
    ];
    if (query.feeCodes?.length) where.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.natures?.length) where.push(`TRIM(b.nature_code) IN (${query.natures.map(add).join(',')})`);
    const paidCutoff = query.paidDateTo ? ` AND b.paid_date <= ${add(query.paidDateTo)}` : '';
    const sql = `SELECT b.office_code AS "officeCode", b.s_id AS "sId",
        MAX(b.address) AS "address", MAX(b.owner_name) AS "ownerName",
        MAX(r.area_sqm)::float8 AS "areaSqm",
        substr(b.period,5,2)::int AS "month",
        COALESCE(SUM(b.amount_cents),0)::bigint AS "receivableCents",
        COALESCE(SUM(CASE WHEN b.paid_date IS NOT NULL${paidCutoff} THEN b.amount_cents ELSE 0 END),0)::bigint AS "receivedCents"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_room r ON r.s_id = b.s_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.office_code, b.s_id, substr(b.period,5,2)
      ORDER BY b.office_code, b.s_id, substr(b.period,5,2)`;
    const raw: any[] = await this.dataSource.query(sql, params);
    const report = buildCollectionAssessment(
      raw.map((row) => ({
        officeCode: row.officeCode == null ? '' : String(row.officeCode),
        sId: row.sId == null ? null : Number(row.sId),
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
        month: Number(row.month),
        receivableCents: Number(row.receivableCents || 0),
        receivedCents: Number(row.receivedCents || 0),
      })),
      limit,
      offset,
    );
    return { ...base, rows: report.rows, summary: report.summary, count: report.count, available: true, message: null };
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

  private async mirrorState(tenantId: number): Promise<MirrorState> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT
           (SELECT COUNT(*)::int FROM mis_mirror_bill) AS "billCount",
           (SELECT last_success_at FROM mis_sync_state WHERE tenant_id = $1 AND source_table = 'bill' LIMIT 1) AS "lastSuccessAt",
           (SELECT MAX(synced_at) FROM mis_mirror_bill) AS "maxSyncedAt"`,
        [tenantId],
      )
      .catch(() => []);
    const row = rows[0] ?? {};
    const syncedAt = row.lastSuccessAt ?? row.maxSyncedAt ?? null;
    return {
      billCount: Number(row.billCount ?? 0),
      dataAsOf: syncedAt ? new Date(syncedAt).toISOString() : null,
    };
  }

  /** 欠收/溢收公共 WHERE 与两个块条件（同一组 $asOf/$cutoff 参数复用）。 */
  private buildArrearsContext(
    add: (value: unknown) => string,
    officeCodes: string[],
    query: ArrearsFilterInput & { asOfPeriod: string },
  ) {
    const periodParam = add(query.asOfPeriod);
    const cutoffParam = query.paidDateTo ? add(query.paidDateTo) : null;
    const where: string[] = [
      `b.office_code IN (${officeCodes.map(add).join(',')})`,
      `b.period ~ '^[0-9]{6}$'`,
    ];
    if (query.feeCodes?.length) where.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.natures?.length) where.push(`TRIM(b.nature_code) IN (${query.natures.map(add).join(',')})`);
    const arrearsCond = `(b.refund_date IS NULL AND (b.paid_date IS NULL${cutoffParam ? ` OR b.paid_date > ${cutoffParam}` : ''}) AND b.period <= ${periodParam} AND b.amount_cents > 0)`;
    const prepaidCond = `(b.refund_date IS NULL AND b.paid_date IS NOT NULL${cutoffParam ? ` AND b.paid_date <= ${cutoffParam}` : ''} AND b.period > ${periodParam} AND b.amount_cents > 0)`;
    where.push(`(${arrearsCond} OR ${prepaidCond})`);
    return { params: [] as unknown[], where, arrearsCond, prepaidCond };
  }
}
