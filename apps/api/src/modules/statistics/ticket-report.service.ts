import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { TicketSummaryQueryDto, TicketsQueryDto, TicketItemFiltersQueryDto, TicketItemsSummaryQueryDto, TicketItemsDetailQueryDto } from './dto';
import { parseCollectionDate, validateCollectionDateRange } from './collection.util';
import {
  normalizeCashierLabel,
  normalizeMethodLabel,
  TICKET_STATUSES,
  UNRECORDED_LABEL,
  type TicketStatus,
} from './ticket-report.util';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
  STATISTICS_OFFICE_NAMES,
  type StatisticsOffice,
} from './statistics.util';

const MIRROR_UNAVAILABLE_MESSAGE =
  'MIS 镜像尚未同步或没有账单数据，请管理员先执行镜像重灌后再查看报表';
const TICKET_MIRROR_MISSING_MESSAGE =
  '票据镜像未同步或无票据数据，票据金额/税额/不含税收入列暂显示 0';

const TICKET_STATUS_SQL = `CASE
  WHEN t.void_date IS NOT NULL THEN 'voided'
  WHEN t.pre_issue THEN 'pre_issue'
  WHEN t.writeoff_date IS NOT NULL THEN 'written_off'
  ELSE 'issued' END`;

interface TicketMirrorState {
  available: boolean;
  count: number;
  dataAsOf: string | null;
}

/**
 * P2-E 报表：收款汇总表 /statistics/ticket-summary、票据情况统计 /statistics/tickets。
 *
 * 收款汇总表同时展示两套口径：
 * - bills 金额块：paid_date ∈ 区间（refund_date IS NULL），行=收费项目，列=收款方式字典+未记录；received=含负调整；
 * - tickets 开票块：ticket_item join ticket，issue_date ∈ 区间，金额/税额/不含税收入/张数按 fee_code 匹配；
 * 两张表口径不同（收款 vs 开票），接口分开返回，前端分别标注。
 * 票据情况统计按 issue_date 区间，status 由 void/pre_issue/writeoff 派生；statusCounts 不受 status 过滤影响。
 */
@Injectable()
export class TicketReportService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  async ticketSummary(query: TicketSummaryQueryDto, user: AuthUser, access?: ResolvedAccess) {
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
      paymentMethods: query.paymentMethods ?? null,
      cashier: query.cashier ?? null,
      limit,
      offset,
    };
    const billState = await this.billMirrorState(tenantId);
    const ticketState = await this.ticketMirrorState(tenantId);
    const methodRows: any[] = await this.dataSource
      .query(`SELECT method_name FROM mis_mirror_payment_method ORDER BY method_id`)
      .catch(() => []);
    const methodLabels = [
      ...new Set([
        ...methodRows.map((row) => String(row.method_name ?? '').trim()).filter(Boolean),
        UNRECORDED_LABEL,
      ]),
    ];
    const methodColumns = methodLabels.map((label) => ({ key: label, label }));
    const emptyMethods = () => Object.fromEntries(methodLabels.map((label) => [label, 0])) as Record<string, number>;
    const base = {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      methodColumns,
      filters,
      limit,
      offset,
      dataAsOf: billState.dataAsOf,
    };
    if (!billState.available) {
      return {
        ...base, rows: [], totals: null, cashierRows: [], cashierTotals: null, count: null,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], count: 0,
        totals: this.emptySummaryTotals(methodLabels),
        cashierRows: [], cashierTotals: this.emptyCashierTotals(methodLabels),
        available: true, message: ticketState.available ? null : TICKET_MIRROR_MISSING_MESSAGE,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const officeParam = `(${selected.map((office) => add(office.officeCode)).join(',')})`;
    const methodExpr = `COALESCE(NULLIF(TRIM(b.payment_method),''),'${UNRECORDED_LABEL}')`;
    const cashierExpr = `COALESCE(NULLIF(TRIM(b.cashier),''),'${UNRECORDED_LABEL}')`;
    const billWhere: string[] = [
      `b.office_code IN ${officeParam}`,
      `b.paid_date >= ${add(range.dateFrom)}::date`,
      `b.paid_date < (${add(range.dateTo)}::date + INTERVAL '1 day')`,
      'b.refund_date IS NULL',
    ];
    if (query.feeCodes?.length) billWhere.push(`b.fee_code IN (${query.feeCodes.map(add).join(',')})`);
    if (query.paymentMethods?.length) {
      billWhere.push(`${methodExpr} IN (${query.paymentMethods.map((method) => add(normalizeMethodLabel(method))).join(',')})`);
    }
    if (query.cashier) billWhere.push(`${cashierExpr} = ${add(normalizeCashierLabel(query.cashier))}`);
    const billWhereSql = billWhere.join(' AND ');
    // 各 SQL 使用独立参数快照，避免 Promise.all 并发构建时互相污染参数数组。
    const billParams = params.slice();
    const refundParams: unknown[] = [];
    const addRefund = (value: unknown) => {
      refundParams.push(value);
      return `$${refundParams.length}`;
    };
    const refundWhere: string[] = [
      `b.office_code IN (${selected.map((office) => addRefund(office.officeCode)).join(',')})`,
      `b.refund_date >= ${addRefund(range.dateFrom)}::date`,
      `b.refund_date < (${addRefund(range.dateTo)}::date + INTERVAL '1 day')`,
      'b.amount_cents > 0',
    ];
    if (query.feeCodes?.length) refundWhere.push(`b.fee_code IN (${query.feeCodes.map(addRefund).join(',')})`);
    if (query.paymentMethods?.length) {
      refundWhere.push(`${methodExpr} IN (${query.paymentMethods.map((method) => addRefund(normalizeMethodLabel(method))).join(',')})`);
    }
    if (query.cashier) refundWhere.push(`${cashierExpr} = ${addRefund(normalizeCashierLabel(query.cashier))}`);
    const [billAgg, refundAgg, cashierAgg, feeRows] = await Promise.all([
      this.dataSource.query(
        `SELECT b.fee_code AS "feeCode", ${methodExpr} AS "method",
                COALESCE(SUM(b.amount_cents),0)::bigint AS "cents", COUNT(*)::int AS "rows"
           FROM mis_mirror_bill b
          WHERE ${billWhereSql}
          GROUP BY b.fee_code, ${methodExpr}`,
        billParams,
      ),
      this.dataSource.query(
        `SELECT b.fee_code AS "feeCode", COALESCE(SUM(ABS(b.amount_cents)),0)::bigint AS "refundCents"
           FROM mis_mirror_bill b
          WHERE ${refundWhere.join(' AND ')}
          GROUP BY b.fee_code`,
        refundParams,
      ),
      this.dataSource.query(
        `SELECT ${cashierExpr} AS "cashier", ${methodExpr} AS "method",
                COALESCE(SUM(b.amount_cents),0)::bigint AS "cents", COUNT(*)::int AS "rows"
           FROM mis_mirror_bill b
          WHERE ${billWhereSql}
          GROUP BY ${cashierExpr}, ${methodExpr}`,
        billParams,
      ),
      this.dataSource.query(`SELECT fee_code AS "feeCode", fee_name AS "feeName" FROM mis_mirror_fee_item`),
    ]);
    // 票据(开票)块独立参数：issue_date 区间 + office + feeCodes。
    const ticketParams: unknown[] = [];
    const addTicket = (value: unknown) => {
      ticketParams.push(value);
      return `$${ticketParams.length}`;
    };
    const ticketWhere: string[] = [
      `t.office_code IN (${selected.map((office) => addTicket(office.officeCode)).join(',')})`,
      `t.issue_date >= ${addTicket(range.dateFrom)}::date`,
      `t.issue_date < (${addTicket(range.dateTo)}::date + INTERVAL '1 day')`,
    ];
    if (query.feeCodes?.length) ticketWhere.push(`ti.fee_code IN (${query.feeCodes.map(addTicket).join(',')})`);
    const ticketWhereSql = ticketWhere.join(' AND ');
    let ticketAgg: any[] = [];
    let ticketTotals: any = {};
    if (ticketState.available) {
      [ticketAgg, ticketTotals] = await Promise.all([
        this.dataSource.query(
          `SELECT ti.fee_code AS "feeCode",
                  COALESCE(SUM(ti.amount_cents),0)::bigint AS "ticketAmountCents",
                  COALESCE(SUM(ti.tax_cents),0)::bigint AS "ticketTaxCents",
                  COALESCE(SUM(ti.amount_cents - ti.tax_cents),0)::bigint AS "ticketIncomeCents",
                  COUNT(DISTINCT t.id)::int AS "ticketCount"
             FROM mis_mirror_ticket_item ti
             INNER JOIN mis_mirror_ticket t ON t.id = ti.ticket_id
            WHERE ${ticketWhereSql}
            GROUP BY ti.fee_code`,
          ticketParams,
        ),
        this.dataSource.query(
          `SELECT COALESCE(SUM(ti.amount_cents),0)::bigint AS "ticketAmountCents",
                  COALESCE(SUM(ti.tax_cents),0)::bigint AS "ticketTaxCents",
                  COALESCE(SUM(ti.amount_cents - ti.tax_cents),0)::bigint AS "ticketIncomeCents",
                  COUNT(DISTINCT t.id)::int AS "ticketCount"
             FROM mis_mirror_ticket_item ti
             INNER JOIN mis_mirror_ticket t ON t.id = ti.ticket_id
            WHERE ${ticketWhereSql}`,
          ticketParams,
        ),
      ]);
    }
    const feeNameByCode = new Map(feeRows.map((row: any) => [String(row.feeCode), String(row.feeName ?? '')]));
    const billByFee = new Map<string, Record<string, number>>();
    const rowsByFee = new Map<string, number>();
    for (const row of billAgg) {
      const feeCode = String(row.feeCode ?? '');
      const methods = billByFee.get(feeCode) ?? Object.fromEntries(methodLabels.map((label) => [label, 0]));
      const method = normalizeMethodLabel(row.method);
      methods[method] = (methods[method] ?? 0) + Number(row.cents || 0);
      billByFee.set(feeCode, methods);
      rowsByFee.set(feeCode, (rowsByFee.get(feeCode) ?? 0) + Number(row.rows || 0));
    }
    const refundByFee = new Map<string, number>(refundAgg.map((row: any) => [String(row.feeCode), Number(row.refundCents || 0)] as [string, number]));
    const ticketByFee = new Map<string, any>(ticketAgg.map((row: any) => [String(row.feeCode), row] as [string, any]));
    const feeOrder = feeRows.map((row: any) => String(row.feeCode));
    const allFees = [...new Set([...billByFee.keys(), ...refundByFee.keys(), ...ticketByFee.keys()])]
      .sort((left, right) => {
        const leftIndex = feeOrder.indexOf(left);
        const rightIndex = feeOrder.indexOf(right);
        if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
        if (leftIndex !== -1) return -1;
        if (rightIndex !== -1) return 1;
        return left.localeCompare(right);
      });
    const buildRow = (feeCode: string) => {
      const methods = billByFee.get(feeCode) ?? Object.fromEntries(methodLabels.map((label) => [label, 0]));
      const receivedCents = Object.values(methods).reduce((sum, value) => sum + value, 0);
      const ticket = ticketByFee.get(feeCode);
      return {
        feeCode,
        feeName: feeNameByCode.get(feeCode) ?? feeCode,
        methods,
        receivedCents,
        refundCents: refundByFee.get(feeCode) ?? 0,
        netCents: receivedCents,
        ticketAmountCents: ticket ? Number(ticket.ticketAmountCents || 0) : 0,
        ticketTaxCents: ticket ? Number(ticket.ticketTaxCents || 0) : 0,
        ticketIncomeCents: ticket ? Number(ticket.ticketIncomeCents || 0) : 0,
        ticketCount: ticket ? Number(ticket.ticketCount || 0) : 0,
        rows: rowsByFee.get(feeCode) ?? 0,
      };
    };
    const allRows = allFees.map(buildRow);
    const rows = allRows.slice(offset, offset + limit);
    const totals = allRows.reduce(
      (sum, row) => {
        for (const label of methodLabels) {
          sum.methods[label] = (sum.methods[label] ?? 0) + Number(row.methods[label] ?? 0);
        }
        sum.receivedCents += row.receivedCents;
        sum.refundCents += row.refundCents;
        sum.ticketAmountCents += row.ticketAmountCents;
        sum.ticketTaxCents += row.ticketTaxCents;
        sum.ticketIncomeCents += row.ticketIncomeCents;
        sum.rows += row.rows;
        return sum;
      },
      {
        methods: emptyMethods(),
        receivedCents: 0,
        refundCents: 0,
        ticketAmountCents: 0,
        ticketTaxCents: 0,
        ticketIncomeCents: 0,
        ticketCount: 0,
        rows: 0,
      } as any,
    );
    totals.netCents = totals.receivedCents;
    totals.ticketCount = Number(ticketTotals[0]?.ticketCount ?? 0);
    // 收款人块：rows 为同筛选下按收款人×方式聚合。
    const cashierMap = new Map<string, any>();
    for (const row of cashierAgg) {
      const name = normalizeCashierLabel(row.cashier);
      const bucket = cashierMap.get(name) ?? {
        cashier: name,
        methods: Object.fromEntries(methodLabels.map((label) => [label, 0])),
        netCents: 0,
        rows: 0,
      };
      const method = normalizeMethodLabel(row.method);
      bucket.methods[method] = (bucket.methods[method] ?? 0) + Number(row.cents || 0);
      bucket.netCents += Number(row.cents || 0);
      bucket.rows += Number(row.rows || 0);
      cashierMap.set(name, bucket);
    }
    const cashierRows = [...cashierMap.values()].sort((left, right) =>
      right.netCents - left.netCents || left.cashier.localeCompare(right.cashier, 'zh-CN'));
    const cashierTotals = cashierRows.reduce(
      (sum, row) => {
        for (const label of methodLabels) sum.methods[label] += Number(row.methods[label] ?? 0);
        sum.netCents += row.netCents;
        sum.rows += row.rows;
        return sum;
      },
      { methods: emptyMethods(), netCents: 0, rows: 0 } as any,
    );
    return {
      ...base,
      rows,
      totals,
      cashierRows,
      cashierTotals,
      count: allRows.length,
      available: true,
      message: ticketState.available ? null : TICKET_MIRROR_MISSING_MESSAGE,
    };
  }

  async tickets(query: TicketsQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (query.dateFrom && query.dateTo) validateCollectionDateRange(query.dateFrom, query.dateTo);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const status: TicketStatus = query.status ?? 'all';
    if (!TICKET_STATUSES.includes(status)) throw new ForbiddenException('status 不合法');
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      officeCodes: selected.map((office) => office.officeCode),
      status,
      keyword: query.keyword ?? null,
      limit,
      offset,
    };
    const state = await this.ticketMirrorState(tenantId);
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    const emptyCounts = { issued: 0, pre_issue: 0, voided: 0, written_off: 0 };
    if (!state.available) {
      return {
        ...base, rows: [], totals: null, statusCounts: null, count: null,
        available: false, message: 'MIS 票据镜像尚未同步，请管理员先执行镜像重灌后再查看票据情况统计',
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], count: 0,
        totals: { count: 0, amountCents: 0, taxCents: 0, voidedCount: 0, preIssueCount: 0, writtenOffCount: 0 },
        statusCounts: emptyCounts,
        available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`t.office_code IN (${selected.map((office) => add(office.officeCode)).join(',')})`];
    if (query.dateFrom) where.push(`t.issue_date >= ${add(query.dateFrom)}::date`);
    if (query.dateTo) where.push(`t.issue_date < (${add(query.dateTo)}::date + INTERVAL '1 day')`);
    if (query.keyword?.trim()) {
      const pattern = add(`%${query.keyword.trim()}%`);
      where.push(`(COALESCE(t.ticket_no,'') ILIKE ${pattern} OR COALESCE(t.warehouse_no,'') ILIKE ${pattern}
        OR COALESCE(t.payer,'') ILIKE ${pattern} OR COALESCE(t.invoice_no,'') ILIKE ${pattern}
        OR COALESCE(t.address,'') ILIKE ${pattern} OR COALESCE(t.customer_name,'') ILIKE ${pattern}
        OR COALESCE(t.issuer,'') ILIKE ${pattern})`);
    }
    const whereSql = where.join(' AND ');
    const statusWhere = status === 'all' ? '' : ` AND ${TICKET_STATUS_SQL} = '${status}'`;
    const [totalsRaw, statusRaw] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS "count",
                COALESCE(SUM(t.amount_cents),0)::bigint AS "amountCents",
                COALESCE(SUM(t.tax_cents),0)::bigint AS "taxCents",
                COUNT(*) FILTER (WHERE t.void_date IS NOT NULL)::int AS "voidedCount",
                COUNT(*) FILTER (WHERE t.void_date IS NULL AND t.pre_issue)::int AS "preIssueCount",
                COUNT(*) FILTER (WHERE t.void_date IS NULL AND NOT t.pre_issue AND t.writeoff_date IS NOT NULL)::int AS "writtenOffCount"
           FROM mis_mirror_ticket t WHERE ${whereSql}${statusWhere}`,
        params,
      ),
      this.dataSource.query(
        `SELECT ${TICKET_STATUS_SQL} AS "status", COUNT(*)::int AS "count"
           FROM mis_mirror_ticket t WHERE ${whereSql} GROUP BY 1`,
        params,
      ),
    ]);
    const statusCounts = { ...emptyCounts } as Record<string, number>;
    for (const row of statusRaw) statusCounts[String(row.status)] = Number(row.count || 0);
    const limitParam = add(limit);
    const offsetParam = add(offset);
    const raw: any[] = await this.dataSource.query(
      `SELECT t.id, t.ticket_no AS "ticketNo", t.warehouse_no AS "warehouseNo", t.office_code AS "officeCode",
              to_char(t.issue_date,'YYYY-MM-DD') AS "issueDate", t.payer,
              t.amount_cents::bigint AS "amountCents", t.tax_cents::bigint AS "taxCents", t.pre_issue AS "preIssue",
              to_char(t.receipt_date,'YYYY-MM-DD') AS "receiptDate", t.issuer, t.payee,
              to_char(t.void_date,'YYYY-MM-DD') AS "voidDate", t.void_reason AS "voidReason",
              to_char(t.writeoff_date,'YYYY-MM-DD') AS "writeoffDate", t.payment_method AS "paymentMethod",
              t.invoice_no AS "invoiceNo", ${TICKET_STATUS_SQL} AS "status"
         FROM mis_mirror_ticket t
        WHERE ${whereSql}${statusWhere}
        ORDER BY t.issue_date DESC NULLS LAST, t.id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const rows = raw.map((row) => {
      const officeCode = row.officeCode == null ? null : String(row.officeCode);
      return {
        id: Number(row.id),
        ticketNo: row.ticketNo == null ? null : String(row.ticketNo),
        warehouseNo: row.warehouseNo == null ? null : String(row.warehouseNo),
        officeCode,
        officeName: officeCode == null ? null : (STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`),
        issueDate: row.issueDate == null ? null : String(row.issueDate),
        payer: row.payer == null ? null : String(row.payer),
        amountCents: Number(row.amountCents || 0),
        taxCents: Number(row.taxCents || 0),
        preIssue: Boolean(row.preIssue),
        receiptDate: row.receiptDate == null ? null : String(row.receiptDate),
        issuer: row.issuer == null ? null : String(row.issuer),
        payee: row.payee == null ? null : String(row.payee),
        voidDate: row.voidDate == null ? null : String(row.voidDate),
        voidReason: row.voidReason == null ? null : String(row.voidReason),
        writeoffDate: row.writeoffDate == null ? null : String(row.writeoffDate),
        paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
        invoiceNo: row.invoiceNo == null ? null : String(row.invoiceNo),
        status: String(row.status),
      };
    });
    const totalsRow = totalsRaw[0] ?? {};
    const count = Number(totalsRow.count || 0);
    return {
      ...base,
      rows,
      totals: {
        count,
        amountCents: Number(totalsRow.amountCents || 0),
        taxCents: Number(totalsRow.taxCents || 0),
        voidedCount: Number(totalsRow.voidedCount || 0),
        preIssueCount: Number(totalsRow.preIssueCount || 0),
        writtenOffCount: Number(totalsRow.writtenOffCount || 0),
      },
      statusCounts,
      count,
      available: true,
      message: null,
    };
  }

  /** 开票行口径；分组张数不可直接相加（同一票据可含多个费项）。 */
  async ticketItemsSummary(query: TicketItemsSummaryQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const groupBy = query.groupBy ?? 'fee';
    if (!['fee', 'office', 'day'].includes(groupBy)) throw new BadRequestException('groupBy 必须是 fee/office/day');
    const context = await this.ticketItemsContext(query, user, access);
    const base = { groupBy, filters: context.filters, dataAsOf: context.state.dataAsOf, coverage: context.coverage };
    if (!context.state.available) return { ...base, rows: [], totals: null, available: false, message: context.message };
    const key = groupBy === 'fee' ? `COALESCE(i.fee_code,'')`
      : groupBy === 'office' ? `COALESCE(t.office_code,'')` : `COALESCE(to_char(t.issue_date,'YYYY-MM-DD'),'')`;
    const raw: any[] = await this.dataSource.query(
      `SELECT ${key} AS key, ${this.ticketItemAggregateSql()}
       FROM mis_mirror_ticket_item i JOIN mis_mirror_ticket t ON t.id=i.ticket_id
       WHERE ${context.where} GROUP BY 1
       ORDER BY ${groupBy === 'day' ? 'key ASC' : '"amountCents" DESC, key ASC'}`, context.params);
    const fees: any[] = groupBy === 'fee'
      ? await this.dataSource.query('SELECT fee_code, fee_name FROM mis_mirror_fee_item') : [];
    const labels = new Map(fees.map(row => [String(row.fee_code), row.fee_name]));
    const rows = raw.map(row => ({
      key: String(row.key),
      label: groupBy === 'office' ? (STATISTICS_OFFICE_NAMES[row.key] ?? row.key)
        : groupBy === 'fee' ? (labels.get(row.key) || row.key || '未分类') : (row.key || '未记录日期'),
      ...this.ticketItemNumbers(row),
    }));
    const totals = await this.ticketItemTotals(context.where, context.params);
    return { ...base, rows, totals, available: true, message: null };
  }

  async ticketItemsDetail(query: TicketItemsDetailQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('分页参数不合法');
    }
    const context = await this.ticketItemsContext(query, user, access);
    const base = { filters: { ...context.filters, ticketNo: query.ticketNo ?? null, keyword: query.keyword ?? null },
      limit, offset, dataAsOf: context.state.dataAsOf, coverage: context.coverage };
    if (!context.state.available) return { ...base, rows: [], totals: null, count: null, available: false, message: context.message };
    const totals = await this.ticketItemTotals(context.where, context.params);
    const rows = await this.loadTicketItems(context.where, context.params, limit, offset);
    return { ...base, rows, totals, count: totals.itemCount, available: true, message: null };
  }

  async ticketItems(id: number, user: AuthUser, access?: ResolvedAccess) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('票据 id 不合法');
    const tenantId = this.requireTenant(user);
    const selected = await this.selectedOffices(tenantId, access);
    if (!selected.length) throw new NotFoundException('票据不存在');
    const ticketState = await this.ticketMirrorState(tenantId);
    if (!ticketState.available) return { ticket: null, rows: [], totals: null, available: false,
      dataAsOf: ticketState.dataAsOf, message: '票据镜像尚未同步，不能将未同步数据视为 0' };
    const params: unknown[] = [id, ...selected.map(office => office.officeCode)];
    const raw: any[] = await this.dataSource.query(
      `SELECT id, ticket_no AS "ticketNo", warehouse_no AS "warehouseNo", office_code AS "officeCode",
       to_char(issue_date,'YYYY-MM-DD') AS "issueDate", payer, address, customer_name AS "customerName",
       invoice_no AS "invoiceNo", amount_cents AS "amountCents", tax_cents AS "taxCents"
       FROM mis_mirror_ticket WHERE id=$1 AND office_code IN (${selected.map((_, index) => `$${index + 2}`).join(',')})`, params);
    if (!raw.length) throw new NotFoundException('票据不存在');
    const ticket = { ...raw[0], id: Number(raw[0].id), amountCents: Number(raw[0].amountCents || 0),
      taxCents: Number(raw[0].taxCents || 0), officeName: STATISTICS_OFFICE_NAMES[raw[0].officeCode] ?? raw[0].officeCode };
    const state = await this.ticketItemMirrorState(tenantId);
    if (!state.available) return { ticket, rows: [], totals: null, available: false,
      dataAsOf: state.dataAsOf, message: '票据开票明细镜像尚未同步，不能将未同步数据视为 0' };
    const rows = await this.loadTicketItems('t.id=$1', [id]);
    const totals = await this.ticketItemTotals('t.id=$1', [id]);
    return { ticket, rows, totals, available: true, dataAsOf: state.dataAsOf, message: null };
  }

  private ticketItemAggregateSql() {
    return `COUNT(*)::int AS "itemCount", COUNT(DISTINCT t.id)::int AS "ticketCount",
      COALESCE(SUM(i.amount_cents),0)::bigint AS "amountCents", COALESCE(SUM(i.tax_cents),0)::bigint AS "taxCents",
      COALESCE(SUM(COALESCE(i.amount_cents,0)-COALESCE(i.tax_cents,0)),0)::bigint AS "incomeCents"`;
  }

  private ticketItemNumbers(row: any) {
    return { itemCount: Number(row.itemCount || 0), ticketCount: Number(row.ticketCount || 0),
      amountCents: Number(row.amountCents || 0), taxCents: Number(row.taxCents || 0), incomeCents: Number(row.incomeCents || 0) };
  }

  private async ticketItemTotals(where: string, params: unknown[]) {
    const raw: any[] = await this.dataSource.query(`SELECT ${this.ticketItemAggregateSql()}
      FROM mis_mirror_ticket_item i JOIN mis_mirror_ticket t ON t.id=i.ticket_id WHERE ${where}`, params);
    return this.ticketItemNumbers(raw[0] ?? {});
  }

  private async loadTicketItems(where: string, params: unknown[], limit?: number, offset = 0) {
    const pagination = limit == null ? '' : ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const raw: any[] = await this.dataSource.query(
      `SELECT i.id AS "itemId", t.id AS "ticketId", t.ticket_no AS "ticketNo", t.warehouse_no AS "warehouseNo",
       to_char(t.issue_date,'YYYY-MM-DD') AS "issueDate", t.office_code AS "officeCode", t.invoice_no AS "invoiceNo",
       i.item_name AS "itemName", i.project, i.fee_code AS "feeCode", COALESCE(f.fee_name,i.fee_code) AS "feeName",
       i.amount_cents AS "amountCents", i.tax_cents AS "taxCents",
       COALESCE(i.amount_cents,0)-COALESCE(i.tax_cents,0) AS "incomeCents"
       FROM mis_mirror_ticket_item i JOIN mis_mirror_ticket t ON t.id=i.ticket_id
       LEFT JOIN mis_mirror_fee_item f ON f.fee_code=i.fee_code WHERE ${where}
       ORDER BY t.issue_date DESC NULLS LAST, t.id DESC, i.id ASC${pagination}`,
      limit == null ? params : [...params, limit, offset]);
    return raw.map(row => ({ ...row, itemId: Number(row.itemId), ticketId: Number(row.ticketId),
      officeName: STATISTICS_OFFICE_NAMES[row.officeCode] ?? row.officeCode,
      amountCents: Number(row.amountCents || 0), taxCents: Number(row.taxCents || 0), incomeCents: Number(row.incomeCents || 0) }));
  }

  private async ticketItemsContext(query: TicketItemFiltersQueryDto & { ticketNo?: string; keyword?: string },
    user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (query.dateFrom) parseCollectionDate(query.dateFrom, 'dateFrom');
    if (query.dateTo) parseCollectionDate(query.dateTo, 'dateTo');
    if (query.dateFrom && query.dateTo) validateCollectionDateRange(query.dateFrom, query.dateTo);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const state = await this.ticketItemMirrorState(tenantId);
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const where = [selected.length ? `t.office_code IN (${selected.map(office => add(office.officeCode)).join(',')})` : 'FALSE'];
    // 覆盖范围只受授权管理处/费项约束，不随日期和关键词缩小；页面不能硬编码历史年份或税额状态。
    if (query.feeCodes?.length) where.push(`i.fee_code IN (${query.feeCodes.map(code => add(code)).join(',')})`);
    const coverageRaw: any[] = state.available ? await this.dataSource.query(
      `SELECT to_char(MIN(t.issue_date),'YYYY-MM-DD') AS "dateFrom", to_char(MAX(t.issue_date),'YYYY-MM-DD') AS "dateTo",
       COUNT(*)::int AS "itemCount", COUNT(DISTINCT t.id)::int AS "ticketCount",
       COUNT(*) FILTER (WHERE i.tax_cents <> 0)::int AS "nonzeroTaxItemCount",
       COUNT(*) FILTER (WHERE i.tax_cents IS NULL)::int AS "unknownTaxItemCount"
       FROM mis_mirror_ticket_item i JOIN mis_mirror_ticket t ON t.id=i.ticket_id WHERE ${where.join(' AND ')}`, params) : [];
    const coverage = coverageRaw.length ? { ...coverageRaw[0], itemCount: Number(coverageRaw[0].itemCount),
      ticketCount: Number(coverageRaw[0].ticketCount), nonzeroTaxItemCount: Number(coverageRaw[0].nonzeroTaxItemCount),
      unknownTaxItemCount: Number(coverageRaw[0].unknownTaxItemCount) } : null;
    if (query.dateFrom) where.push(`t.issue_date >= ${add(query.dateFrom)}::date`);
    if (query.dateTo) where.push(`t.issue_date < (${add(query.dateTo)}::date + INTERVAL '1 day')`);
    if (query.ticketNo) where.push(`t.ticket_no=${add(query.ticketNo)}`);
    if (query.keyword?.trim()) {
      const p = add(`%${query.keyword.trim()}%`);
      where.push(`(COALESCE(t.ticket_no,'') ILIKE ${p} OR COALESCE(t.warehouse_no,'') ILIKE ${p}
        OR COALESCE(t.invoice_no,'') ILIKE ${p} OR COALESCE(i.item_name,'') ILIKE ${p} OR COALESCE(i.fee_code,'') ILIKE ${p})`);
    }
    return { state, coverage, params, where: where.join(' AND '), filters: { dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null, officeCodes: selected.map(office => office.officeCode), feeCodes: query.feeCodes ?? null },
      message: '票据或开票明细镜像尚未同步，不能将未同步数据视为 0' };
  }

  private async ticketItemMirrorState(tenantId: number) {
    const tickets = await this.ticketMirrorState(tenantId);
    const raw: any[] = await this.dataSource.query(`SELECT COUNT(*)::int AS count, MAX(synced_at) AS "dataAsOf",
      (SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='ticket_item' LIMIT 1) AS "lastSuccessAt"
      FROM mis_mirror_ticket_item`, [tenantId]).catch(() => []);
    const item = raw[0] ?? {};
    const synced = item.lastSuccessAt ?? item.dataAsOf;
    const dates = [tickets.dataAsOf, synced].filter(Boolean).map(value => new Date(value).getTime());
    return { available: tickets.available && (Number(item.count || 0) > 0 || Boolean(item.lastSuccessAt)),
      dataAsOf: dates.length ? new Date(Math.min(...dates)).toISOString() : null };
  }

  private emptySummaryTotals(methodLabels: string[]) {
    return {
      methods: Object.fromEntries(methodLabels.map((label) => [label, 0])),
      receivedCents: 0,
      refundCents: 0,
      netCents: 0,
      ticketAmountCents: 0,
      ticketTaxCents: 0,
      ticketIncomeCents: 0,
      ticketCount: 0,
      rows: 0,
    };
  }

  private emptyCashierTotals(methodLabels: string[]) {
    return {
      methods: Object.fromEntries(methodLabels.map((label) => [label, 0])),
      netCents: 0,
      rows: 0,
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

  private async billMirrorState(tenantId: number): Promise<{ available: boolean; dataAsOf: string | null }> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT (SELECT COUNT(*)::int FROM mis_mirror_bill) AS "billCount",
                (SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill' LIMIT 1) AS "lastSuccessAt",
                (SELECT MAX(synced_at) FROM mis_mirror_bill) AS "maxSyncedAt"`,
        [tenantId],
      )
      .catch(() => []);
    const row = rows[0] ?? {};
    const syncedAt = row.lastSuccessAt ?? row.maxSyncedAt ?? null;
    return {
      available: Number(row.billCount ?? 0) > 0 || Boolean(row.lastSuccessAt),
      dataAsOf: syncedAt ? new Date(syncedAt).toISOString() : null,
    };
  }

  private async ticketMirrorState(tenantId: number): Promise<TicketMirrorState> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT (SELECT COUNT(*)::int FROM mis_mirror_ticket) AS "ticketCount",
                (SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='ticket' LIMIT 1) AS "lastSuccessAt",
                (SELECT MAX(synced_at) FROM mis_mirror_ticket) AS "maxSyncedAt"`,
        [tenantId],
      )
      .catch(() => []);
    const row = rows[0] ?? {};
    const syncedAt = row.lastSuccessAt ?? row.maxSyncedAt ?? null;
    return {
      available: Number(row.ticketCount ?? 0) > 0 || Boolean(row.lastSuccessAt),
      count: Number(row.ticketCount ?? 0),
      dataAsOf: syncedAt ? new Date(syncedAt).toISOString() : null,
    };
  }
}
