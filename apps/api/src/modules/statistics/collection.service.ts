import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  buildCollectionDailyReport,
  buildCollectionFeeNatureReport,
  buildCollectionMonthlyReport,
  collectionGroupLabel,
  nextCollectionDate,
  validateCollectionDateRange,
  validateCollectionYear,
  type CollectionDetailKind,
  type CollectionFeeColumn,
  type CollectionGroupBy,
} from './collection.util';
import {
  CollectionDailyQueryDto,
  CollectionDetailQueryDto,
  CollectionFeeNatureQueryDto,
  CollectionMonthlyQueryDto,
  CollectionSummaryQueryDto,
} from './dto';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
  STATISTICS_NATURE_OPTIONS,
  STATISTICS_OFFICE_NAMES,
  type StatisticsOffice,
} from './statistics.util';

const MIRROR_UNAVAILABLE_MESSAGE =
  'MIS 镜像尚未同步或没有账单数据，请管理员先执行镜像重灌后再查看收费汇总报表';

interface MirrorState {
  billCount: number;
  dataAsOf: string | null;
}

interface BuiltSql {
  sql: string;
  params: unknown[];
}

/** 收费汇总公共筛选（付款日期口径报表使用）。 */
interface CollectionFilterInput {
  feeCodes?: string[];
  natures?: string[];
  paymentMethods?: string[];
  cashier?: string;
  yearFrom?: number;
  yearTo?: number;
}

/** 月报表（P2-A 旧口径实现）沿用的筛选。 */
interface BillFilterOptions {
  feeCodes?: string[];
  natures?: string[];
  paidDateTo?: string;
}

export interface BlockTotals {
  receivedCents: number;
  refundCents: number;
  adjustCents: number;
  netCents: number;
}

interface CollectionSqlContext {
  params: unknown[];
  where: string[];
  receivedCond: string;
  refundCond: string;
  adjustCond: string;
  netCond: string;
  anyBlockCond: string;
}

/** 退款/红冲行判定（仅月报表旧口径沿用）。 */
const REFUND_ROW_SQL = '(b.refund_date IS NOT NULL OR b.amount_cents < 0)';
const EVENT_DATE_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN COALESCE(b.refund_date, b.paid_date) ELSE b.paid_date END)`;
const NET_AMOUNT_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN -ABS(b.amount_cents) ELSE b.amount_cents END)`;

/**
 * P2 收费汇总类只读报表。
 *
 * P2-B 统一四类口径（docs/statistics-p2-report-layouts.md §2.2 / §4.1）：
 * - 收款块 received = Σ amount_cents WHERE paid_date ∈ [from,to+1) AND refund_date IS NULL AND amount>0
 * - 退款块 refund   = Σ ABS(amount_cents) WHERE refund_date ∈ [from,to+1) AND amount>0（成对负数行不重复计）
 * - 调整块 adjust   = Σ amount_cents WHERE paid_date ∈ [from,to+1) AND refund_date IS NULL AND amount<0
 * - 净额 net        = received + adjust − refund（= paid_date ∈ 区间且 refund_date IS NULL 的 Σ amount）
 *
 * 日期区间统一左闭右开 [dateFrom, dateTo+1)；房屋性质按 bill.nature_code（TRIM，空值不算任何性质）；
 * 金额一律整数分；报表固定常数条参数化 SQL，无 N+1；未镜像时 available:false + message，不伪造 0。
 */
@Injectable()
export class CollectionStatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/collection/summary：收款/退款/调整/净额按 fee|office|method|cashier 分组。 */
  async collectionSummary(
    query: CollectionSummaryQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const groupBy: CollectionGroupBy = query.groupBy ?? 'fee';
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = this.collectionFilters(range, selected, query, { groupBy });
    const state = await this.mirrorState(tenantId);
    const base = {
      groupBy,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      filters,
      dataAsOf: state.dataAsOf,
    };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], total: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], total: this.emptyBlockTotals(), available: true, message: null,
      };
    }
    const context = this.buildCollectionSqlContext(selected.map((office) => office.officeCode), range, query);
    const keyExpr = this.groupKeySql(groupBy);
    const labelExpr = groupBy === 'fee'
      ? `COALESCE(NULLIF(MAX(fi.fee_name),''),NULLIF(MAX(b.fee_name),''),b.fee_code)`
      : keyExpr;
    const join = groupBy === 'fee' ? 'LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code' : '';
    const sql = `SELECT ${keyExpr} AS "key", ${labelExpr} AS "label",
        COALESCE(SUM(CASE WHEN ${context.receivedCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "receivedCents",
        COALESCE(SUM(CASE WHEN ${context.refundCond} THEN ABS(b.amount_cents) ELSE 0 END),0)::bigint AS "refundCents",
        COALESCE(SUM(CASE WHEN ${context.adjustCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "adjustCents",
        COALESCE(SUM(CASE WHEN ${context.netCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "netCents",
        COUNT(*) FILTER (WHERE ${context.receivedCond})::int AS "countReceived",
        COUNT(*) FILTER (WHERE ${context.refundCond})::int AS "countRefund",
        COUNT(*) FILTER (WHERE ${context.adjustCond})::int AS "countAdjust"
      FROM mis_mirror_bill b
      ${join}
      WHERE ${context.where.join(' AND ')} AND ${context.anyBlockCond}
      GROUP BY ${keyExpr}
      ORDER BY "netCents" DESC, "key" ASC`;
    const raw: any[] = await this.dataSource.query(sql, context.params);
    const rows = raw.map((row) => {
      const key = row.key == null ? '' : String(row.key);
      const countReceived = Number(row.countReceived || 0);
      const countRefund = Number(row.countRefund || 0);
      const countAdjust = Number(row.countAdjust || 0);
      return {
        key,
        label: collectionGroupLabel(groupBy, key, row.label == null ? null : String(row.label)),
        receivedCents: Number(row.receivedCents || 0),
        refundCents: Number(row.refundCents || 0),
        adjustCents: Number(row.adjustCents || 0),
        netCents: Number(row.netCents || 0),
        countReceived,
        countRefund,
        countAdjust,
        count: countReceived + countRefund + countAdjust,
      };
    });
    const total = rows.reduce(
      (sum, row) => ({
        receivedCents: sum.receivedCents + row.receivedCents,
        refundCents: sum.refundCents + row.refundCents,
        adjustCents: sum.adjustCents + row.adjustCents,
        netCents: sum.netCents + row.netCents,
        countReceived: sum.countReceived + row.countReceived,
        countRefund: sum.countRefund + row.countRefund,
        countAdjust: sum.countAdjust + row.countAdjust,
        count: sum.count + row.count,
      }),
      { ...this.emptyBlockTotals(), countReceived: 0, countRefund: 0, countAdjust: 0, count: 0 },
    );
    return { ...base, rows, total, available: true, message: null };
  }

  /** GET /statistics/collection/fee-nature：收费项目 × 房屋性质净额矩阵。 */
  async collectionFeeNature(
    query: CollectionFeeNatureQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = this.collectionFilters(range, selected, query);
    const state = await this.mirrorState(tenantId);
    const base = {
      dateFrom: range.dateFrom, dateTo: range.dateTo, filters, dataAsOf: state.dataAsOf,
    };
    if (state.billCount === 0) {
      return {
        ...base, columns: [], natures: STATISTICS_NATURE_OPTIONS, rows: [], subtotal: null,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const columns = await this.feeColumns(query.feeCodes);
    if (!selected.length) {
      const empty = buildCollectionFeeNatureReport(columns, STATISTICS_NATURE_OPTIONS, []);
      return {
        ...base, columns: empty.columns, natures: STATISTICS_NATURE_OPTIONS,
        rows: empty.rows, subtotal: empty.subtotal, available: true, message: null,
      };
    }
    const context = this.buildCollectionSqlContext(selected.map((office) => office.officeCode), range, query);
    const sql = `SELECT b.fee_code AS "feeCode", COALESCE(TRIM(b.nature_code),'') AS "natureCode",
        COALESCE(SUM(CASE WHEN ${context.receivedCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "receivedCents",
        COALESCE(SUM(CASE WHEN ${context.refundCond} THEN ABS(b.amount_cents) ELSE 0 END),0)::bigint AS "refundCents",
        COALESCE(SUM(CASE WHEN ${context.adjustCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "adjustCents"
      FROM mis_mirror_bill b
      WHERE ${context.where.join(' AND ')} AND ${context.anyBlockCond}
      GROUP BY b.fee_code, COALESCE(TRIM(b.nature_code),'')
      ORDER BY 1, 2`;
    const raw: any[] = await this.dataSource.query(sql, context.params);
    const report = buildCollectionFeeNatureReport(
      columns,
      STATISTICS_NATURE_OPTIONS,
      raw.map((row) => ({
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        natureCode: row.natureCode == null ? null : String(row.natureCode),
        receivedCents: Number(row.receivedCents || 0),
        refundCents: Number(row.refundCents || 0),
        adjustCents: Number(row.adjustCents || 0),
      })),
    );
    return {
      ...base,
      columns: report.columns,
      natures: STATISTICS_NATURE_OPTIONS,
      rows: report.rows,
      subtotal: report.subtotal,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/collection/detail：收款/退款/调整逐笔明细，totals 随 kind 收敛。 */
  async collectionDetail(
    query: CollectionDetailQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const kind: CollectionDetailKind = query.kind ?? 'all';
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = this.collectionFilters(range, selected, query, { kind });
    const state = await this.mirrorState(tenantId);
    const base = { dateFrom: range.dateFrom, dateTo: range.dateTo, filters, limit, offset, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, rows: [], totals: null, count: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], totals: this.emptyBlockTotals(), count: 0, available: true, message: null,
      };
    }
    const context = this.buildCollectionSqlContext(selected.map((office) => office.officeCode), range, query);
    const kindCond = this.detailKindSql(kind, context);
    const where = `${context.where.join(' AND ')} AND ${kindCond}`;
    const totalsSql = `SELECT
        COALESCE(SUM(CASE WHEN ${context.receivedCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "receivedCents",
        COALESCE(SUM(CASE WHEN ${context.refundCond} THEN ABS(b.amount_cents) ELSE 0 END),0)::bigint AS "refundCents",
        COALESCE(SUM(CASE WHEN ${context.adjustCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "adjustCents",
        COALESCE(SUM(CASE WHEN ${context.netCond} THEN b.amount_cents ELSE 0 END),0)::bigint AS "netCents",
        COUNT(*)::int AS "count"
      FROM mis_mirror_bill b
      WHERE ${where}`;
    // 先算全量合计（用未追加 limit/offset 的参数），再追加分页参数查当前页。
    const totalsRaw: any[] = await this.dataSource.query(totalsSql, context.params);
    const addParams = (value: unknown) => {
      context.params.push(value);
      return `$${context.params.length}`;
    };
    const limitParam = addParams(limit);
    const offsetParam = addParams(offset);
    const rowKindSql = `CASE WHEN ${context.refundCond} THEN 'refund'
        WHEN ${context.adjustCond} THEN 'adjust' ELSE 'received' END`;
    const rowsSql = `SELECT ${rowKindSql} AS "rowKind",
        b.zj_id AS "zjId", b.office_code AS "officeCode",
        b.address AS "address", b.owner_name AS "ownerName", b.room_no AS "roomNo",
        b.fee_code AS "feeCode",
        COALESCE(NULLIF(fi.fee_name,''),NULLIF(b.fee_name,''),b.fee_code) AS "feeName",
        NULLIF(TRIM(b.nature_code),'') AS "natureCode",
        b.period AS "period", b.amount_cents::bigint AS "amountCents",
        to_char(b.paid_date,'YYYY-MM-DD') AS "paidDate",
        to_char(b.refund_date,'YYYY-MM-DD') AS "refundDate",
        b.payment_method AS "paymentMethod", b.cashier AS "cashier"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code
      WHERE ${where}
      ORDER BY CASE WHEN ${context.refundCond} THEN b.refund_date ELSE b.paid_date END DESC, b.zj_id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`;
    const raw: any[] = await this.dataSource.query(rowsSql, context.params);
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? '' : String(row.officeCode);
      return {
        rowKind: String(row.rowKind),
        zjId: Number(row.zjId),
        officeCode,
        officeName: STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`,
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        roomNo: row.roomNo == null ? null : String(row.roomNo),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        feeName: row.feeName == null ? null : String(row.feeName),
        natureCode: row.natureCode == null ? null : String(row.natureCode),
        period: row.period == null ? null : String(row.period),
        amountCents: Number(row.amountCents || 0),
        paidDate: row.paidDate == null ? null : String(row.paidDate),
        refundDate: row.refundDate == null ? null : String(row.refundDate),
        paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
        cashier: row.cashier == null ? null : String(row.cashier),
      };
    });
    const totalsRow = totalsRaw[0] ?? {};
    const receivedCents = Number(totalsRow.receivedCents || 0);
    const refundCents = Number(totalsRow.refundCents || 0);
    const adjustCents = Number(totalsRow.adjustCents || 0);
    const totals = kind === 'received'
      ? { receivedCents, refundCents: 0, adjustCents: 0, netCents: receivedCents }
      : kind === 'refund'
        ? { receivedCents: 0, refundCents, adjustCents: 0, netCents: -refundCents }
        : kind === 'adjust'
          ? { receivedCents: 0, refundCents: 0, adjustCents, netCents: adjustCents }
          : { receivedCents, refundCents, adjustCents, netCents: Number(totalsRow.netCents || 0) };
    return {
      ...base,
      rows,
      totals,
      count: Number(totalsRow.count || 0),
      available: true,
      message: null,
    };
  }

  /** GET /statistics/daily：日常收费项目收款日报表；cells=收款块，退款/调整单列。 */
  async daily(query: CollectionDailyQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = this.collectionFilters(range, selected, query);
    const state = await this.mirrorState(tenantId);
    const base = { dateFrom: range.dateFrom, dateTo: range.dateTo, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, columns: [], rows: [], subtotal: null,
        refundTotalCents: null, adjustTotalCents: null,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const columns = await this.feeColumns(query.feeCodes);
    if (!selected.length) {
      const empty = buildCollectionDailyReport(columns, []);
      return {
        ...base, columns: empty.columns, rows: empty.rows, subtotal: empty.subtotal,
        refundTotalCents: empty.refundTotalCents, adjustTotalCents: empty.adjustTotalCents,
        available: true, message: null,
      };
    }
    const context = this.buildCollectionSqlContext(selected.map((office) => office.officeCode), range, query);
    const where = context.where.join(' AND ');
    // 一条 SQL：收款块按收款日、调整块按收款日、退款块按退款日 UNION ALL 后按日期×费项聚合。
    const sql = `SELECT to_char(x.day,'YYYY-MM-DD') AS "date", x.fee_code AS "feeCode",
        COALESCE(SUM(CASE WHEN x.kind='received' THEN x.amount ELSE 0 END),0)::bigint AS "receivedCents",
        COALESCE(SUM(CASE WHEN x.kind='refund' THEN x.amount ELSE 0 END),0)::bigint AS "refundCents",
        COALESCE(SUM(CASE WHEN x.kind='adjust' THEN x.amount ELSE 0 END),0)::bigint AS "adjustCents"
      FROM (
        SELECT b.paid_date AS day, b.fee_code, 'received' AS kind, b.amount_cents AS amount
          FROM mis_mirror_bill b WHERE ${where} AND ${context.receivedCond}
        UNION ALL
        SELECT b.paid_date AS day, b.fee_code, 'adjust' AS kind, b.amount_cents AS amount
          FROM mis_mirror_bill b WHERE ${where} AND ${context.adjustCond}
        UNION ALL
        SELECT b.refund_date AS day, b.fee_code, 'refund' AS kind, ABS(b.amount_cents) AS amount
          FROM mis_mirror_bill b WHERE ${where} AND ${context.refundCond}
      ) x
      GROUP BY x.day, x.fee_code
      ORDER BY 1, 2`;
    const raw: any[] = await this.dataSource.query(sql, context.params);
    const table = buildCollectionDailyReport(
      columns,
      raw.map((row) => ({
        date: String(row.date ?? ''),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        receivedCents: Number(row.receivedCents || 0),
        refundCents: Number(row.refundCents || 0),
        adjustCents: Number(row.adjustCents || 0),
      })),
    );
    return {
      ...base,
      columns: table.columns,
      rows: table.rows,
      subtotal: table.subtotal,
      refundTotalCents: table.refundTotalCents,
      adjustTotalCents: table.adjustTotalCents,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/monthly：月报表（P2-A 旧净额口径，P2-B 未改此报表）。 */
  async monthly(query: CollectionMonthlyQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const year = validateCollectionYear(query.year);
    const dateFrom = `${year}-01-01`;
    const dateTo = `${year}-12-31`;
    validateCollectionDateRange(dateFrom, dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      year,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paidDateTo: query.paidDateTo ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { year, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base, columns: [], rows: [], subtotal: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const columns = await this.feeColumns(query.feeCodes);
    if (!selected.length) {
      const empty = buildCollectionMonthlyReport(columns, []);
      return {
        ...base, columns: empty.columns, rows: empty.rows, subtotal: empty.subtotal,
        available: true, message: null,
      };
    }
    const built = this.buildMonthlySql(
      selected.map((office) => office.officeCode),
      dateFrom,
      dateTo,
      query,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const table = buildCollectionMonthlyReport(
      columns,
      raw.map((row) => ({
        month: Number(row.month),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        amountCents: Number(row.amountCents || 0),
      })),
    );
    return {
      ...base, columns: table.columns, rows: table.rows, subtotal: table.subtotal,
      available: true, message: null,
    };
  }

  private emptyBlockTotals(): BlockTotals {
    return { receivedCents: 0, refundCents: 0, adjustCents: 0, netCents: 0 };
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }

  private async loadCommunities(tenantId: number): Promise<Array<{ id: number; name: string }>> {
    const rows = await this.communityRepo.find({ where: { tenantId } }).catch(() => []);
    return rows.map((community) => ({ id: community.id, name: community.name }));
  }

  private async officeScope(tenantId: number, access?: ResolvedAccess): Promise<StatisticsOffice[]> {
    const communities = await this.loadCommunities(tenantId);
    return resolveStatisticsOffices(communities, scopeCommunityIds(access));
  }

  /** 数据范围收敛 + 勾选过滤；勾选了越权管理处时收敛为空表，不泄露数据。 */
  private async selectedOffices(
    tenantId: number,
    access: ResolvedAccess | undefined,
    requested?: string[],
  ): Promise<StatisticsOffice[]> {
    const offices = await this.officeScope(tenantId, access);
    return filterRequestedOffices(offices, requested);
  }

  private async loadFeeItems(): Promise<CollectionFeeColumn[]> {
    const rows: any[] = await this.dataSource
      .query('SELECT fee_code AS "code", fee_name AS "name" FROM mis_mirror_fee_item ORDER BY fee_code')
      .catch(() => []);
    return rows.map((row) => ({ code: String(row.code), name: String(row.name ?? '') }));
  }

  /** 报表列：字典 16 项；传 feeCodes 时按字典顺序取交集，字典缺的代码也保留（名称回退代码）。 */
  private async feeColumns(requested?: string[]): Promise<CollectionFeeColumn[]> {
    const items = await this.loadFeeItems();
    if (!requested?.length) return items;
    const wanted = new Set(requested);
    const columns = items.filter((item) => wanted.has(item.code));
    for (const code of requested) {
      if (!columns.some((column) => column.code === code)) columns.push({ code, name: code });
    }
    return columns;
  }

  /** 镜像水位：一次查询拿到账单行数和最近成功同步时间；行数 0 表示未镜像。 */
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

  private collectionFilters(
    range: { dateFrom: string; dateTo: string },
    selected: StatisticsOffice[],
    query: CollectionFilterInput,
    extra?: Record<string, unknown>,
  ) {
    return {
      ...extra,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paymentMethods: query.paymentMethods ?? null,
      cashier: query.cashier ?? null,
      yearFrom: query.yearFrom ?? null,
      yearTo: query.yearTo ?? null,
    };
  }

  private groupKeySql(groupBy: CollectionGroupBy): string {
    if (groupBy === 'fee') return 'b.fee_code';
    if (groupBy === 'office') return 'b.office_code';
    if (groupBy === 'method') return `COALESCE(NULLIF(TRIM(b.payment_method),''),'')`;
    return `COALESCE(NULLIF(TRIM(b.cashier),''),'')`;
  }

  private detailKindSql(kind: CollectionDetailKind, context: CollectionSqlContext): string {
    if (kind === 'received') return context.receivedCond;
    if (kind === 'refund') return context.refundCond;
    if (kind === 'adjust') return context.adjustCond;
    return context.anyBlockCond;
  }

  /**
   * 公共参数/WHERE 与四类块条件。
   * 事件行并集（收款/退款日期落在区间）用同一组 $from/$to 参数，下面三个块条件复用，避免重复绑定。
   */
  private buildCollectionSqlContext(
    officeCodes: string[],
    range: { dateFrom: string; dateTo: string },
    query: CollectionFilterInput,
  ): CollectionSqlContext {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const fromParam = add(range.dateFrom);
    const toParam = add(nextCollectionDate(range.dateTo));
    const where: string[] = [
      `b.office_code IN (${officeCodes.map(add).join(',')})`,
      `((b.paid_date >= ${fromParam} AND b.paid_date < ${toParam}) OR (b.refund_date >= ${fromParam} AND b.refund_date < ${toParam}))`,
    ];
    if (query.feeCodes?.length) where.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.natures?.length) where.push(`TRIM(b.nature_code) IN (${query.natures.map(add).join(',')})`);
    if (query.paymentMethods?.length) {
      where.push(`TRIM(b.payment_method) IN (${query.paymentMethods.map((method) => add(method.trim())).join(',')})`);
    }
    if (query.cashier) where.push(`TRIM(b.cashier) = ${add(query.cashier.trim())}`);
    if (query.yearFrom != null || query.yearTo != null) {
      where.push(`b.period ~ '^[0-9]{6}$'`);
      if (query.yearFrom != null && query.yearTo != null) {
        where.push(`substr(b.period,1,4)::int BETWEEN ${add(query.yearFrom)} AND ${add(query.yearTo)}`);
      } else if (query.yearFrom != null) {
        where.push(`substr(b.period,1,4)::int >= ${add(query.yearFrom)}`);
      } else if (query.yearTo != null) {
        where.push(`substr(b.period,1,4)::int <= ${add(query.yearTo)}`);
      }
    }
    const receivedCond = `(b.paid_date >= ${fromParam} AND b.paid_date < ${toParam} AND b.refund_date IS NULL AND b.amount_cents > 0)`;
    const refundCond = `(b.refund_date >= ${fromParam} AND b.refund_date < ${toParam} AND b.amount_cents > 0)`;
    const adjustCond = `(b.paid_date >= ${fromParam} AND b.paid_date < ${toParam} AND b.refund_date IS NULL AND b.amount_cents < 0)`;
    const netCond = `(b.paid_date >= ${fromParam} AND b.paid_date < ${toParam} AND b.refund_date IS NULL)`;
    return {
      params,
      where,
      receivedCond,
      refundCond,
      adjustCond,
      netCond,
      anyBlockCond: `(${receivedCond} OR ${refundCond} OR ${adjustCond})`,
    };
  }

  /**
   * 公共 WHERE（月报表旧口径沿用）：管理处范围 + 事件日期区间 + 收费项目/房屋性质/收款截止日。
   */
  private buildBillWhere(
    params: unknown[],
    officeCodes: string[],
    dateFrom: string,
    dateTo: string,
    options: BillFilterOptions,
  ): string {
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses: string[] = [
      `b.office_code IN (${officeCodes.map(add).join(',')})`,
      `${EVENT_DATE_SQL} BETWEEN ${add(dateFrom)} AND ${add(dateTo)}`,
    ];
    if (options.feeCodes?.length) clauses.push(`b.fee_code IN (${options.feeCodes.map(add).join(',')})`);
    if (options.natures?.length) clauses.push(`TRIM(b.nature_code) IN (${options.natures.map(add).join(',')})`);
    if (options.paidDateTo) clauses.push(`${EVENT_DATE_SQL} <= ${add(options.paidDateTo)}`);
    return clauses.join(' AND ');
  }

  /** 月报：一条 GROUP BY（月份 × 收费项目）聚合 SQL（旧净额口径）。 */
  private buildMonthlySql(
    officeCodes: string[],
    dateFrom: string,
    dateTo: string,
    options: BillFilterOptions,
  ): BuiltSql {
    const params: unknown[] = [];
    const where = this.buildBillWhere(params, officeCodes, dateFrom, dateTo, options);
    const sql = `SELECT EXTRACT(MONTH FROM ${EVENT_DATE_SQL})::int AS "month",
        b.fee_code AS "feeCode",
        COALESCE(SUM(${NET_AMOUNT_SQL}),0)::bigint AS "amountCents"
      FROM mis_mirror_bill b
      WHERE ${where}
      GROUP BY EXTRACT(MONTH FROM ${EVENT_DATE_SQL}), b.fee_code
      ORDER BY 1, 2`;
    return { sql, params };
  }
}
