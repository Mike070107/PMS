import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  buildCollectionDailyReport,
  buildCollectionMonthlyReport,
  collectionGroupLabel,
  validateCollectionDateRange,
  validateCollectionYear,
  type CollectionFeeColumn,
  type CollectionGroupBy,
} from './collection.util';
import {
  CollectionDailyQueryDto,
  CollectionDetailQueryDto,
  CollectionMonthlyQueryDto,
  CollectionSummaryQueryDto,
} from './dto';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
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

interface BillFilterOptions {
  feeCodes?: string[];
  natures?: string[];
  paidDateTo?: string;
}

/** 退款/红冲行判定：源系统可能只写负金额、也可能 refund_date 非空。 */
const REFUND_ROW_SQL = '(b.refund_date IS NOT NULL OR b.amount_cents < 0)';
/** 报表事件日期：收款按收款日期，退款按退款日期（缺失时回退收款日期）。 */
const EVENT_DATE_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN COALESCE(b.refund_date, b.paid_date) ELSE b.paid_date END)`;
const RECEIVED_AMOUNT_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN 0 ELSE b.amount_cents END)`;
const REFUND_AMOUNT_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN ABS(b.amount_cents) ELSE 0 END)`;
const NET_AMOUNT_SQL = `(CASE WHEN ${REFUND_ROW_SQL} THEN -ABS(b.amount_cents) ELSE b.amount_cents END)`;

/**
 * P2-A 收费汇总类只读报表：收费汇总 / 实收明细 / 日常收费项目收款日报表 / 月报表。
 *
 * 净额口径（与 P1 实收口径一致，但把「实收 / 退款」拆成两列）：
 * - 退款/红冲行：refund_date 非空，或金额为负（源系统红冲行金额可能写成负数）。
 * - 事件日期：收款行 = paid_date；退款行 = COALESCE(refund_date, paid_date)。
 * - 净额：收款行 = amount_cents；退款行 = -ABS(amount_cents)。
 *
 * 这样「收款 - 退款」与逐笔明细净额之和恒等，daily/monthly 单元格也能用
 * collection/detail 相同条件复算。未镜像时返回 available:false + message，不伪造 0。
 * 金额一律整数分，SQL 里 SUM(...)::bigint，接口不做元/分换算。
 * 数据只来自 PostgreSQL 的 mis_mirror_* 只读镜像；每条报表固定 1 条账单聚合 SQL，无 N+1。
 */
@Injectable()
export class CollectionStatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/collection/summary：实收/退款按 fee|office|method|cashier 分组。 */
  async collectionSummary(
    query: CollectionSummaryQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const groupBy: CollectionGroupBy = query.groupBy ?? 'fee';
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      groupBy,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paidDateTo: query.paidDateTo ?? null,
    };
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
        ...base,
        rows: [],
        total: null,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base,
        rows: [],
        total: { receivedCents: 0, refundCents: 0, count: 0 },
        available: true,
        message: null,
      };
    }
    const built = this.buildSummarySql(
      selected.map((office) => office.officeCode),
      groupBy,
      range.dateFrom,
      range.dateTo,
      query,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const rows = raw.map((row) => {
      const key = row.key == null ? '' : String(row.key);
      return {
        key,
        label: collectionGroupLabel(groupBy, key, row.label == null ? null : String(row.label)),
        receivedCents: Number(row.receivedCents || 0),
        refundCents: Number(row.refundCents || 0),
        count: Number(row.count || 0),
      };
    });
    const total = rows.reduce(
      (sum, row) => ({
        receivedCents: sum.receivedCents + row.receivedCents,
        refundCents: sum.refundCents + row.refundCents,
        count: sum.count + row.count,
      }),
      { receivedCents: 0, refundCents: 0, count: 0 },
    );
    return { ...base, rows, total, available: true, message: null };
  }

  /** GET /statistics/collection/detail：逐笔实收/退款明细，totalCents = Σ净额。 */
  async collectionDetail(
    query: CollectionDetailQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paidDateTo: query.paidDateTo ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base,
        rows: [],
        totalCents: null,
        count: null,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return { ...base, rows: [], totalCents: 0, count: 0, available: true, message: null };
    }
    const built = this.buildDetailRowsSql(
      selected.map((office) => office.officeCode),
      range.dateFrom,
      range.dateTo,
      limit,
      offset,
      query,
    );
    const totalsBuilt = this.buildDetailTotalsSql(
      selected.map((office) => office.officeCode),
      range.dateFrom,
      range.dateTo,
      query,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const totals: any[] = await this.dataSource.query(totalsBuilt.sql, totalsBuilt.params);
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? '' : String(row.officeCode);
      return {
        zjId: Number(row.zjId),
        officeCode,
        officeName: STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`,
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        roomNo: row.roomNo == null ? null : String(row.roomNo),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        feeName: row.feeName == null ? null : String(row.feeName),
        period: row.period == null ? null : String(row.period),
        amountCents: Number(row.amountCents || 0),
        paidDate: row.paidDate == null ? null : String(row.paidDate),
        refundDate: row.refundDate == null ? null : String(row.refundDate),
        paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
        cashier: row.cashier == null ? null : String(row.cashier),
        natureCode: row.natureCode == null ? null : String(row.natureCode),
      };
    });
    // 合计/条数单独一条聚合 SQL，按筛选全量算；翻页（含 offset 超出）不影响合计。
    const totalRow = totals[0] ?? {};
    const totalCents = Number(totalRow.totalCents || 0);
    const count = Number(totalRow.count || 0);
    return { ...base, rows, totalCents, count, available: true, message: null };
  }

  /** GET /statistics/daily：日常收费项目收款日报表（行=日期，列=收费项目）。 */
  async daily(query: CollectionDailyQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const range = validateCollectionDateRange(query.dateFrom, query.dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      paidDateTo: query.paidDateTo ?? null,
    };
    const state = await this.mirrorState(tenantId);
    const base = { dateFrom: range.dateFrom, dateTo: range.dateTo, filters, dataAsOf: state.dataAsOf };
    if (state.billCount === 0) {
      return {
        ...base,
        columns: [],
        rows: [],
        subtotal: null,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const columns = await this.feeColumns(query.feeCodes);
    if (!selected.length) {
      // 授权范围为空：报表结构仍完整（列为字典/勾选项，行/合计为 0），不查账单。
      const empty = buildCollectionDailyReport(columns, []);
      return {
        ...base,
        columns: empty.columns,
        rows: empty.rows,
        subtotal: empty.subtotal,
        available: true,
        message: null,
      };
    }
    const built = this.buildDailySql(
      selected.map((office) => office.officeCode),
      range.dateFrom,
      range.dateTo,
      query,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const table = buildCollectionDailyReport(
      columns,
      raw.map((row) => ({
        date: String(row.date ?? ''),
        feeCode: row.feeCode == null ? null : String(row.feeCode),
        amountCents: Number(row.amountCents || 0),
      })),
    );
    return {
      ...base,
      columns: table.columns,
      rows: table.rows,
      subtotal: table.subtotal,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/monthly：月报表（行=1–12 月，列=收费项目）。 */
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
        ...base,
        columns: [],
        rows: [],
        subtotal: null,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const columns = await this.feeColumns(query.feeCodes);
    if (!selected.length) {
      // 授权范围为空：月报表仍返回 12 个月全 0 行，结构不变。
      const empty = buildCollectionMonthlyReport(columns, []);
      return {
        ...base,
        columns: empty.columns,
        rows: empty.rows,
        subtotal: empty.subtotal,
        available: true,
        message: null,
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
      ...base,
      columns: table.columns,
      rows: table.rows,
      subtotal: table.subtotal,
      available: true,
      message: null,
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

  /**
   * 公共 WHERE：管理处范围 + 事件日期区间 + 收费项目/房屋性质/收款截止日。
   * 全部走 $n 参数，管理处 IN 列表也逐个参数化。
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
    if (options.feeCodes?.length) {
      clauses.push(`b.fee_code IN (${options.feeCodes.map(add).join(',')})`);
    }
    if (options.natures?.length) {
      clauses.push(`TRIM(b.nature_code) IN (${options.natures.map(add).join(',')})`);
    }
    if (options.paidDateTo) clauses.push(`${EVENT_DATE_SQL} <= ${add(options.paidDateTo)}`);
    return clauses.join(' AND ');
  }

  /** 汇总：一条 GROUP BY 聚合 SQL（分组维度 + 管理处范围 + 全部筛选）。 */
  private buildSummarySql(
    officeCodes: string[],
    groupBy: CollectionGroupBy,
    dateFrom: string,
    dateTo: string,
    options: BillFilterOptions,
  ): BuiltSql {
    const params: unknown[] = [];
    const keyExpr =
      groupBy === 'fee'
        ? 'b.fee_code'
        : groupBy === 'office'
          ? 'b.office_code'
          : groupBy === 'method'
            ? `COALESCE(NULLIF(TRIM(b.payment_method),''),'')`
            : `COALESCE(NULLIF(TRIM(b.cashier),''),'')`;
    const labelExpr =
      groupBy === 'office'
        ? 'b.office_code'
        : groupBy === 'fee'
          ? `COALESCE(NULLIF(MAX(fi.fee_name),''),NULLIF(MAX(b.fee_name),''),b.fee_code)`
          : groupBy === 'method'
            ? `COALESCE(NULLIF(MAX(TRIM(b.payment_method)),''),'未填写')`
            : `COALESCE(NULLIF(MAX(TRIM(b.cashier)),''),'未填写')`;
    const join = groupBy === 'fee' ? 'LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code' : '';
    const where = this.buildBillWhere(params, officeCodes, dateFrom, dateTo, options);
    const sql = `SELECT ${keyExpr} AS "key", ${labelExpr} AS "label",
        COALESCE(SUM(${RECEIVED_AMOUNT_SQL}),0)::bigint AS "receivedCents",
        COALESCE(SUM(${REFUND_AMOUNT_SQL}),0)::bigint AS "refundCents",
        COUNT(*)::int AS "count"
      FROM mis_mirror_bill b
      ${join}
      WHERE ${where}
      GROUP BY ${keyExpr}
      ORDER BY "receivedCents" DESC, "refundCents" DESC, "key" ASC`;
    return { sql, params };
  }

  /** 明细行：单页逐笔行（一条 SQL，无 N+1）。 */
  private buildDetailRowsSql(
    officeCodes: string[],
    dateFrom: string,
    dateTo: string,
    limit: number,
    offset: number,
    options: BillFilterOptions,
  ): BuiltSql {
    const params: unknown[] = [];
    const where = this.buildBillWhere(params, officeCodes, dateFrom, dateTo, options);
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const sql = `SELECT b.zj_id AS "zjId", b.office_code AS "officeCode",
        b.owner_name AS "ownerName", b.address AS "address", b.room_no AS "roomNo",
        b.fee_code AS "feeCode",
        COALESCE(NULLIF(fi.fee_name,''),NULLIF(b.fee_name,''),b.fee_code) AS "feeName",
        b.period AS "period",
        (${NET_AMOUNT_SQL})::bigint AS "amountCents",
        to_char(b.paid_date,'YYYY-MM-DD') AS "paidDate",
        to_char(b.refund_date,'YYYY-MM-DD') AS "refundDate",
        b.payment_method AS "paymentMethod",
        b.cashier AS "cashier",
        b.nature_code AS "natureCode"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_fee_item fi ON fi.fee_code = b.fee_code
      WHERE ${where}
      ORDER BY ${EVENT_DATE_SQL} DESC, b.zj_id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`;
    return { sql, params };
  }

  /** 明细全量合计：一条聚合 SQL（COUNT + Σ净额），与翻页无关。 */
  private buildDetailTotalsSql(
    officeCodes: string[],
    dateFrom: string,
    dateTo: string,
    options: BillFilterOptions,
  ): BuiltSql {
    const params: unknown[] = [];
    const where = this.buildBillWhere(params, officeCodes, dateFrom, dateTo, options);
    const sql = `SELECT COUNT(*)::int AS "count",
        COALESCE(SUM(${NET_AMOUNT_SQL}),0)::bigint AS "totalCents"
      FROM mis_mirror_bill b
      WHERE ${where}`;
    return { sql, params };
  }

  /** 日报：一条 GROUP BY（事件日期 × 收费项目）聚合 SQL。 */
  private buildDailySql(
    officeCodes: string[],
    dateFrom: string,
    dateTo: string,
    options: BillFilterOptions,
  ): BuiltSql {
    const params: unknown[] = [];
    const where = this.buildBillWhere(params, officeCodes, dateFrom, dateTo, options);
    const sql = `SELECT to_char(${EVENT_DATE_SQL},'YYYY-MM-DD') AS "date",
        b.fee_code AS "feeCode",
        COALESCE(SUM(${NET_AMOUNT_SQL}),0)::bigint AS "amountCents"
      FROM mis_mirror_bill b
      WHERE ${where}
      GROUP BY ${EVENT_DATE_SQL}, b.fee_code
      ORDER BY 1, 2`;
    return { sql, params };
  }

  /** 月报：一条 GROUP BY（月份 × 收费项目）聚合 SQL。 */
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
