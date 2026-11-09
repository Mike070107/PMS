import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { periodMonthBounds, periodYear, MONTHLY_REPORT_PENDING_COLUMNS, type CollectionAnalysisSort, type MonthlyReportGroupBy } from './analysis.util';
import {
  CollectionAnalysisDetailQueryDto,
  CollectionAnalysisQueryDto,
  MonthlyReportQueryDto,
} from './dto';
import { nextCollectionDate, validateCollectionDateRange } from './collection.util';
import { roundRatePct } from './arrears.util';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
  STATISTICS_OFFICE_NAMES,
  type StatisticsOffice,
} from './statistics.util';

const MIRROR_UNAVAILABLE_MESSAGE =
  'MIS 镜像尚未同步或没有账单数据，请管理员先执行镜像重灌后再查看报表';

interface MirrorState {
  billCount: number;
  dataAsOf: string | null;
}

interface AnalysisFilterInput {
  feeCodes?: string[];
  natures?: string[];
}

interface AnalysisMetricFilters {
  historyArrears: string;
  currentYearArrears: string;
  currentMonthReceivable: string;
  prepaid: string;
  periodReceived: string;
}

/**
 * P2-D 只读报表：收款分析（按户 5 指标 + 该户逐笔）与收费月报表（核心 9 指标）。
 *
 * 口径与 docs/statistics-p2-report-layouts.md §4.8 / §4.4 一致：
 * - 收款分析：历年欠收/当年欠收/当月应收/预缴/区间实收，按房屋聚合；收款区间左闭右开。
 * - 月报表：月应收/月调整/累计应收/旧欠应收/合计应收/本期实收/预收转入/预收余额/当月欠收/累计欠收。
 * 月报表 28 列中约 10 列定义未取证，接口用 pendingColumns 标出，不伪造数据。
 * 未镜像 available:false + message，不伪造 0；金额整数分；固定常数条参数化 SQL，无 N+1。
 */
@Injectable()
export class AnalysisStatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/collection-analysis：收款分析（按户 5 指标）。 */
  async collectionAnalysis(query: CollectionAnalysisQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const sort: CollectionAnalysisSort = query.sort ?? 'currentArrears';
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      asOfPeriod: query.asOfPeriod,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sort,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      limit,
      offset,
    };
    const state = await this.mirrorState(tenantId);
    const base = {
      asOfPeriod: query.asOfPeriod, dateFrom: range.dateFrom, dateTo: range.dateTo,
      filters, limit, offset, dataAsOf: state.dataAsOf,
    };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totals: null, count: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], totals: this.emptyAnalysisTotals(), count: 0, available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const context = this.buildAnalysisContext(add, selected.map((office) => office.officeCode), query, range);
    const where = `${context.where.join(' AND ')}`;
    const order = sort === 'historyArrears'
      ? '"historyArrearsCents" DESC, MAX(b.address) NULLS LAST, b.s_id'
      : sort === 'address'
        ? 'MAX(b.address) NULLS LAST, b.s_id'
        : '"currentYearArrearsCents" DESC, MAX(b.address) NULLS LAST, b.s_id';
    const totalsSql = `SELECT
        COUNT(DISTINCT (b.office_code, b.s_id))::int AS "count",
        COALESCE(SUM(CASE WHEN ${context.filters.historyArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "historyArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentYearArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentYearArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentMonthReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentMonthReceivableCents",
        COALESCE(SUM(CASE WHEN ${context.filters.prepaid} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidCents",
        COALESCE(SUM(CASE WHEN ${context.filters.periodReceived} THEN b.amount_cents ELSE 0 END),0)::bigint AS "periodReceivedCents"
      FROM mis_mirror_bill b
      WHERE ${where}`;
    const totalsRaw: any[] = await this.dataSource.query(totalsSql, params);
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const rowsSql = `SELECT b.s_id AS "sId", b.office_code AS "officeCode",
        MAX(b.address) AS "address", MAX(b.owner_name) AS "ownerName",
        MAX(r.area_sqm)::float8 AS "areaSqm",
        COALESCE(SUM(CASE WHEN ${context.filters.historyArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "historyArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentYearArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentYearArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentMonthReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentMonthReceivableCents",
        COALESCE(SUM(CASE WHEN ${context.filters.prepaid} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidCents",
        COALESCE(SUM(CASE WHEN ${context.filters.periodReceived} THEN b.amount_cents ELSE 0 END),0)::bigint AS "periodReceivedCents"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_room r ON r.s_id = b.s_id
      WHERE ${where}
      GROUP BY b.office_code, b.s_id
      ORDER BY ${order}
      LIMIT ${limitParam} OFFSET ${offsetParam}`;
    const raw: any[] = await this.dataSource.query(rowsSql, params);
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? '' : String(row.officeCode);
      return {
        sId: row.sId == null ? null : Number(row.sId),
        officeCode,
        officeName: STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`,
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
        historyArrearsCents: Number(row.historyArrearsCents || 0),
        currentYearArrearsCents: Number(row.currentYearArrearsCents || 0),
        currentMonthReceivableCents: Number(row.currentMonthReceivableCents || 0),
        prepaidCents: Number(row.prepaidCents || 0),
        periodReceivedCents: Number(row.periodReceivedCents || 0),
      };
    });
    const totalsRow = totalsRaw[0] ?? {};
    return {
      ...base,
      rows,
      totals: {
        historyArrearsCents: Number(totalsRow.historyArrearsCents || 0),
        currentYearArrearsCents: Number(totalsRow.currentYearArrearsCents || 0),
        currentMonthReceivableCents: Number(totalsRow.currentMonthReceivableCents || 0),
        prepaidCents: Number(totalsRow.prepaidCents || 0),
        periodReceivedCents: Number(totalsRow.periodReceivedCents || 0),
      },
      count: Number(totalsRow.count ?? 0),
      available: true,
      message: null,
    };
  }

  /** GET /statistics/collection-analysis/detail：某房屋全部账单，行内标注 arrears/prepaid/received。 */
  async collectionAnalysisDetail(query: CollectionAnalysisDetailQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      asOfPeriod: query.asOfPeriod,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sId: query.sId,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { asOfPeriod: query.asOfPeriod, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totals: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return { ...base, rows: [], totals: this.emptyAnalysisTotals(), available: true, message: null };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const context = this.buildAnalysisContext(add, selected.map((office) => office.officeCode), query, range);
    const sIdParam = add(query.sId);
    const houseWhere = `${context.where.join(' AND ')} AND b.s_id = ${sIdParam} AND b.refund_date IS NULL
      AND ((b.paid_date IS NULL AND b.amount_cents > 0)
        OR (b.paid_date IS NOT NULL AND b.period > ${context.asOfParam} AND b.amount_cents > 0)
        OR (b.paid_date >= ${context.fromParam} AND b.paid_date < ${context.toParam}))`;
    const totalsSql = `SELECT
        COALESCE(SUM(CASE WHEN ${context.filters.historyArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "historyArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentYearArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentYearArrearsCents",
        COALESCE(SUM(CASE WHEN ${context.filters.currentMonthReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "currentMonthReceivableCents",
        COALESCE(SUM(CASE WHEN ${context.filters.prepaid} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidCents",
        COALESCE(SUM(CASE WHEN ${context.filters.periodReceived} THEN b.amount_cents ELSE 0 END),0)::bigint AS "periodReceivedCents"
      FROM mis_mirror_bill b
      WHERE ${houseWhere}`;
    const totalsRaw: any[] = await this.dataSource.query(totalsSql, params);
    // 行查询单独绑定参数：只引用它真正使用的占位符，避免未使用参数无法推断类型。
    const rowsParams: unknown[] = [];
    const addRow = (value: unknown) => {
      rowsParams.push(value);
      return `$${rowsParams.length}`;
    };
    const rowWhere: string[] = [
      `b.office_code IN (${selected.map((office) => addRow(office.officeCode)).join(',')})`,
      'b.refund_date IS NULL',
      `b.s_id = ${addRow(query.sId)}`,
    ];
    if (query.feeCodes?.length) rowWhere.push(`b.fee_code IN (${query.feeCodes.map(addRow).join(',')})`);
    if (query.natures?.length) rowWhere.push(`TRIM(b.nature_code) IN (${query.natures.map(addRow).join(',')})`);
    const rowAsOfParam = addRow(query.asOfPeriod);
    const rowFromParam = addRow(range.dateFrom);
    const rowToParam = addRow(nextCollectionDate(range.dateTo));
    rowWhere.push(`((b.paid_date IS NULL AND b.amount_cents > 0)
        OR (b.paid_date IS NOT NULL AND b.period > ${rowAsOfParam} AND b.amount_cents > 0)
        OR (b.paid_date >= ${rowFromParam} AND b.paid_date < ${rowToParam}))`);
    const rowsSql = `SELECT b.zj_id AS "zjId", b.period AS "period", b.amount_cents::bigint AS "amountCents",
        to_char(b.paid_date,'YYYY-MM-DD') AS "paidDate",
        to_char(b.refund_date,'YYYY-MM-DD') AS "refundDate",
        b.payment_method AS "paymentMethod", b.cashier AS "cashier",
        b.fee_code AS "feeCode",
        COALESCE(NULLIF(fi.fee_name,''),NULLIF(b.fee_name,''),b.fee_code) AS "feeName",
        NULLIF(TRIM(b.nature_code),'') AS "natureCode",
        CASE WHEN b.paid_date IS NULL THEN 'arrears'
             WHEN b.period > ${rowAsOfParam} THEN 'prepaid'
             ELSE 'received' END AS "rowKind"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code
      WHERE ${rowWhere.join(' AND ')}
      ORDER BY b.period, b.zj_id`;
    const raw: any[] = await this.dataSource.query(rowsSql, rowsParams);
    const rows = raw.map((row) => ({
      zjId: Number(row.zjId),
      period: row.period == null ? null : String(row.period),
      amountCents: Number(row.amountCents || 0),
      paidDate: row.paidDate == null ? null : String(row.paidDate),
      refundDate: row.refundDate == null ? null : String(row.refundDate),
      paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
      cashier: row.cashier == null ? null : String(row.cashier),
      feeCode: row.feeCode == null ? null : String(row.feeCode),
      feeName: row.feeName == null ? null : String(row.feeName),
      natureCode: row.natureCode == null ? null : String(row.natureCode),
      rowKind: String(row.rowKind),
    }));
    const totalsRow = totalsRaw[0] ?? {};
    return {
      ...base,
      rows,
      totals: {
        historyArrearsCents: Number(totalsRow.historyArrearsCents || 0),
        currentYearArrearsCents: Number(totalsRow.currentYearArrearsCents || 0),
        currentMonthReceivableCents: Number(totalsRow.currentMonthReceivableCents || 0),
        prepaidCents: Number(totalsRow.prepaidCents || 0),
        periodReceivedCents: Number(totalsRow.periodReceivedCents || 0),
      },
      available: true,
      message: null,
    };
  }

  /** GET /statistics/monthly-report：收费月报表核心 9 指标版（行=管理处）。 */
  async monthlyReport(query: MonthlyReportQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const groupBy: MonthlyReportGroupBy = query.groupBy ?? 'office';
    const bounds = periodMonthBounds(query.asOfPeriod);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      asOfPeriod: query.asOfPeriod,
      groupBy,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { asOfPeriod: query.asOfPeriod, groupBy, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totals: null, pendingColumns: MONTHLY_REPORT_PENDING_COLUMNS,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], totals: this.emptyMonthlyTotals(), pendingColumns: MONTHLY_REPORT_PENDING_COLUMNS,
        available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const asOfParam = add(query.asOfPeriod);
    const prevDecParam = add(bounds.prevYearDec);
    const monthStartParam = add(bounds.monthStart);
    const nextMonthStartParam = add(bounds.nextMonthStart);
    const where: string[] = [
      `b.office_code IN (${selected.map((office) => add(office.officeCode)).join(',')})`,
      'b.refund_date IS NULL',
    ];
    if (query.feeCodes?.length) where.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.natures?.length) where.push(`TRIM(b.nature_code) IN (${query.natures.map(add).join(',')})`);
    const monthReceivable = `(b.period = ${asOfParam} AND b.amount_cents > 0)`;
    const monthAdjust = `(b.period = ${asOfParam} AND b.amount_cents < 0)`;
    const cumulativeReceivable = `(b.period <= ${asOfParam} AND b.amount_cents > 0)`;
    const oldArrearsReceivable = `(b.paid_date IS NULL AND b.period <= ${prevDecParam} AND b.amount_cents > 0)`;
    const monthReceived = `(b.paid_date >= ${monthStartParam} AND b.paid_date < ${nextMonthStartParam})`;
    const prepaidIn = `(b.paid_date < ${monthStartParam} AND b.period = ${asOfParam})`;
    const prepaidBalance = `(b.paid_date < ${nextMonthStartParam} AND b.period > ${asOfParam})`;
    const monthArrears = `(b.paid_date IS NULL AND b.period = ${asOfParam} AND b.amount_cents > 0)`;
    const cumulativeArrears = `(b.paid_date IS NULL AND b.period <= ${asOfParam} AND b.amount_cents > 0)`;
    const sql = `SELECT b.office_code AS "key",
        COALESCE(SUM(CASE WHEN ${monthReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "monthReceivableCents",
        COALESCE(SUM(CASE WHEN ${monthAdjust} THEN b.amount_cents ELSE 0 END),0)::bigint AS "monthAdjustCents",
        COALESCE(SUM(CASE WHEN ${cumulativeReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "cumulativeReceivableCents",
        COALESCE(SUM(CASE WHEN ${oldArrearsReceivable} THEN b.amount_cents ELSE 0 END),0)::bigint AS "oldArrearsReceivableCents",
        COALESCE(SUM(CASE WHEN ${monthReceived} THEN b.amount_cents ELSE 0 END),0)::bigint AS "monthReceivedCents",
        COALESCE(SUM(CASE WHEN ${prepaidIn} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidInCents",
        COALESCE(SUM(CASE WHEN ${prepaidBalance} THEN b.amount_cents ELSE 0 END),0)::bigint AS "prepaidBalanceCents",
        COALESCE(SUM(CASE WHEN ${monthArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "monthArrearsCents",
        COALESCE(SUM(CASE WHEN ${cumulativeArrears} THEN b.amount_cents ELSE 0 END),0)::bigint AS "cumulativeArrearsCents"
      FROM mis_mirror_bill b
      WHERE ${where.join(' AND ')}
      GROUP BY b.office_code
      ORDER BY b.office_code`;
    const raw: any[] = await this.dataSource.query(sql, params);
    const rows = raw.map((row) => {
      const key = row.key == null ? '' : String(row.key);
      const metric = {
        monthReceivableCents: Number(row.monthReceivableCents || 0),
        monthAdjustCents: Number(row.monthAdjustCents || 0),
        cumulativeReceivableCents: Number(row.cumulativeReceivableCents || 0),
        oldArrearsReceivableCents: Number(row.oldArrearsReceivableCents || 0),
        monthReceivedCents: Number(row.monthReceivedCents || 0),
        prepaidInCents: Number(row.prepaidInCents || 0),
        prepaidBalanceCents: Number(row.prepaidBalanceCents || 0),
        monthArrearsCents: Number(row.monthArrearsCents || 0),
        cumulativeArrearsCents: Number(row.cumulativeArrearsCents || 0),
      };
      const totalReceivableCents = metric.cumulativeReceivableCents + metric.oldArrearsReceivableCents;
      return {
        key,
        label: STATISTICS_OFFICE_NAMES[key] ?? `管理处${key}`,
        ...metric,
        totalReceivableCents,
        recoveryRatePct: roundRatePct(metric.monthReceivedCents, totalReceivableCents),
      };
    });
    const totals = rows.reduce(
      (sum, row) => ({
        monthReceivableCents: sum.monthReceivableCents + row.monthReceivableCents,
        monthAdjustCents: sum.monthAdjustCents + row.monthAdjustCents,
        cumulativeReceivableCents: sum.cumulativeReceivableCents + row.cumulativeReceivableCents,
        oldArrearsReceivableCents: sum.oldArrearsReceivableCents + row.oldArrearsReceivableCents,
        totalReceivableCents: sum.totalReceivableCents + row.totalReceivableCents,
        monthReceivedCents: sum.monthReceivedCents + row.monthReceivedCents,
        prepaidInCents: sum.prepaidInCents + row.prepaidInCents,
        prepaidBalanceCents: sum.prepaidBalanceCents + row.prepaidBalanceCents,
        monthArrearsCents: sum.monthArrearsCents + row.monthArrearsCents,
        cumulativeArrearsCents: sum.cumulativeArrearsCents + row.cumulativeArrearsCents,
      }),
      this.emptyMonthlyTotals(),
    );
    return {
      ...base,
      rows,
      totals: { ...totals, recoveryRatePct: roundRatePct(totals.monthReceivedCents, totals.totalReceivableCents) },
      pendingColumns: MONTHLY_REPORT_PENDING_COLUMNS,
      available: true,
      message: null,
    };
  }

  private emptyAnalysisTotals() {
    return {
      historyArrearsCents: 0,
      currentYearArrearsCents: 0,
      currentMonthReceivableCents: 0,
      prepaidCents: 0,
      periodReceivedCents: 0,
    };
  }

  private emptyMonthlyTotals() {
    return {
      monthReceivableCents: 0,
      monthAdjustCents: 0,
      cumulativeReceivableCents: 0,
      oldArrearsReceivableCents: 0,
      totalReceivableCents: 0,
      monthReceivedCents: 0,
      prepaidInCents: 0,
      prepaidBalanceCents: 0,
      monthArrearsCents: 0,
      cumulativeArrearsCents: 0,
      recoveryRatePct: 0,
    };
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

  /** 收款分析公共参数/WHERE + 5 指标 FILTER 条件。 */
  private buildAnalysisContext(
    add: (value: unknown) => string,
    officeCodes: string[],
    query: AnalysisFilterInput & { asOfPeriod: string },
    range: { dateFrom: string; dateTo: string },
  ): {
    where: string[];
    filters: AnalysisMetricFilters;
    asOfParam: string;
    fromParam: string;
    toParam: string;
  } {
    const asOfParam = add(query.asOfPeriod);
    const fromParam = add(range.dateFrom);
    const toParam = add(nextCollectionDate(range.dateTo));
    const yearStart = `${periodYear(query.asOfPeriod)}01`;
    const yearStartParam = add(yearStart);
    const where: string[] = [
      `b.office_code IN (${officeCodes.map(add).join(',')})`,
      'b.refund_date IS NULL',
    ];
    if (query.feeCodes?.length) where.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.natures?.length) where.push(`TRIM(b.nature_code) IN (${query.natures.map(add).join(',')})`);
    const filters: AnalysisMetricFilters = {
      historyArrears: `(b.paid_date IS NULL AND b.period < ${yearStartParam} AND b.amount_cents > 0)`,
      currentYearArrears: `(b.paid_date IS NULL AND substr(b.period,1,4) = ${add(periodYear(query.asOfPeriod))} AND b.period <= ${asOfParam} AND b.amount_cents > 0)`,
      currentMonthReceivable: `(b.period = ${asOfParam} AND b.amount_cents > 0)`,
      prepaid: `(b.paid_date IS NOT NULL AND b.period > ${asOfParam} AND b.amount_cents > 0)`,
      periodReceived: `(b.paid_date >= ${fromParam} AND b.paid_date < ${toParam})`,
    };
    return { where, filters, asOfParam, fromParam, toParam };
  }
}
