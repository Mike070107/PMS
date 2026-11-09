import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  StatisticsAnnualDetailQueryDto,
  StatisticsAnnualQueryDto,
  StatisticsBillsQueryDto,
} from './dto';
import {
  buildAnnualTable,
  filterRequestedOffices,
  formatPeriodRange,
  normalizeStatisticsFeeCategory,
  resolveStatisticsOffices,
  sortStatisticsFeeItems,
  STATISTICS_NATURE_OPTIONS,
  statisticsColumns,
  type StatisticsFeeItem,
  type StatisticsType,
} from './statistics.util';

const DEFAULT_YEAR_FROM = 2004;
const MIRROR_UNAVAILABLE_MESSAGE = 'MIS 镜像尚未同步或没有账单数据，请管理员先执行镜像重灌后再查看统计汇总';

interface MirrorState {
  billCount: number;
  dataAsOf: string | null;
}

interface BuiltSql {
  sql: string;
  params: unknown[];
}

/**
 * 「统计汇总」P1 只读报表：项目欠费年度汇总 / 项目实收年度汇总 + 房屋明细 + 逐笔账单。
 *
 * 数据只来自 PMS PostgreSQL 的 mis_mirror_* 只读镜像（不访问 MIS，也不写任何表）。
 * 金额一律整数分（amount_cents / SUM(amount_cents)，接口不做元/分换算）。
 * 年度汇总/明细各用一条 GROUP BY 聚合 SQL，避免按管理处/年份 N+1。
 */
@Injectable()
export class StatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/options：管理处、收费项目、房屋性质、年度范围、镜像水位。 */
  async options(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const [communities, feeItems, paymentMethods, yearRange, state] = await Promise.all([
      this.loadCommunities(tenantId),
      this.loadFeeItems(),
      this.loadPaymentMethods(),
      this.loadYearRange(),
      this.mirrorState(tenantId),
    ]);
    const offices = resolveStatisticsOffices(communities, scopeCommunityIds(access)).map((office) => ({
      officeCode: office.officeCode,
      name: office.officeName,
      communityId: office.communityId,
      communityName: office.communityName,
    }));
    const available = state.billCount > 0;
    return {
      offices,
      feeItems,
      paymentMethods,
      natures: STATISTICS_NATURE_OPTIONS,
      yearRange,
      dataAsOf: state.dataAsOf,
      sourceMode: 'mirror' as const,
      available,
      message: available ? null : MIRROR_UNAVAILABLE_MESSAGE,
    };
  }

  /** GET /statistics/annual：管理处 × 年度汇总表。 */
  async annual(query: StatisticsAnnualQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const offices = await this.officeScope(tenantId, access);
    const selected = filterRequestedOffices(offices, query.officeCodes);
    const yearFrom = query.yearFrom ?? DEFAULT_YEAR_FROM;
    const yearTo = query.yearTo ?? Math.max(yearFrom, new Date().getFullYear());
    const columns = statisticsColumns(yearFrom, yearTo);
    const filters = {
      type: query.type,
      officeCodes: selected.map((office) => office.officeCode),
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      yearFrom,
      yearTo,
      asOfPeriod: query.asOfPeriod ?? null,
      paidDateTo: query.paidDateTo ?? null,
      paidDateFrom: query.paidDateFrom ?? null,
    };
    const state = await this.mirrorState(tenantId);
    if (state.billCount === 0) {
      return {
        type: query.type,
        columns,
        rows: [],
        subtotal: null,
        filters,
        dataAsOf: state.dataAsOf,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    let raw: Array<{ officeCode: string; year: number | string; amountCents: number | string }> = [];
    if (selected.length) {
      const built = this.buildAnnualSql(
        query.type,
        selected.map((office) => office.officeCode),
        query.feeCodes,
        query.natures,
        yearFrom,
        yearTo,
        query.asOfPeriod,
        query.paidDateTo,
        query.paidDateFrom,
      );
      raw = await this.dataSource.query(built.sql, built.params);
    }
    const table = buildAnnualTable(selected, columns, raw);
    return {
      type: query.type,
      columns,
      rows: table.rows,
      subtotal: table.subtotal,
      filters,
      dataAsOf: state.dataAsOf,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/annual/detail：单元格下钻到房屋聚合明细，合计必须等于单元格。 */
  async annualDetail(query: StatisticsAnnualDetailQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const office = await this.requireOffice(tenantId, access, query.officeCode);
    const filters = {
      type: query.type,
      officeCode: office.officeCode,
      year: query.year,
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      asOfPeriod: query.asOfPeriod ?? null,
      paidDateTo: query.paidDateTo ?? null,
      paidDateFrom: query.paidDateFrom ?? null,
    };
    const state = await this.mirrorState(tenantId);
    if (state.billCount === 0) {
      return {
        ...filters,
        detailKind: query.type,
        officeName: office.officeName,
        rows: [],
        totalCents: null,
        dataAsOf: state.dataAsOf,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    // 实收：旧系统下钻按「房屋 × 应收年月」聚合（成对冲抵行合并显示 0.00）。
    if (query.type === 'received') {
      const built = this.buildReceivedDetailSql(
        office.officeCode,
        query.year,
        query.feeCodes,
        query.natures,
        query.paidDateTo,
        query.paidDateFrom,
      );
      const raw: any[] = await this.dataSource.query(built.sql, built.params);
      const rows = raw.map((row) => ({
        // 聚合后单笔标识/收银信息无意义；收据/发票号镜像缺，一并返回 null。
        zjId: null as number | null,
        sId: row.sId == null ? null : Number(row.sId),
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
        period: row.period == null ? null : String(row.period),
        amountCents: Number(row.amountCents || 0),
        paidDate: row.paidDate == null ? null : String(row.paidDate),
        refundDate: row.refundDate == null ? null : String(row.refundDate),
        paymentMethod: null as string | null,
        cashier: null as string | null,
        receiptNo: null as string | null,
        invoiceNo: null as string | null,
      }));
      const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
      return {
        ...filters,
        detailKind: 'received' as const,
        officeName: office.officeName,
        rows,
        totalCents,
        dataAsOf: state.dataAsOf,
        available: true,
        message: null,
      };
    }
    const built = this.buildDetailSql(
      query.type,
      office.officeCode,
      query.year,
      query.feeCodes,
      query.natures,
      query.asOfPeriod,
      query.paidDateTo,
      query.paidDateFrom,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const rows = raw.map((row) => ({
      sId: row.sId == null ? null : Number(row.sId),
      address: row.address == null ? null : String(row.address),
      ownerName: row.ownerName == null ? null : String(row.ownerName),
      areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
      periodRange: formatPeriodRange(row.periodStart == null ? null : String(row.periodStart),
        row.periodEnd == null ? null : String(row.periodEnd)),
      amountCents: Number(row.amountCents || 0),
    }));
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return {
      ...filters,
      detailKind: 'arrears' as const,
      officeName: office.officeName,
      rows,
      totalCents,
      dataAsOf: state.dataAsOf,
      available: true,
      message: null,
    };
  }

  /** GET /statistics/annual/detail/bills：房屋明细再下钻到逐笔账单。 */
  async annualDetailBills(query: StatisticsBillsQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const office = await this.requireOffice(tenantId, access, query.officeCode);
    const filters = {
      type: query.type,
      officeCode: office.officeCode,
      sId: query.sId,
      year: query.year,
      feeCodes: query.feeCodes ?? null,
      natures: query.natures ?? null,
      asOfPeriod: query.asOfPeriod ?? null,
      paidDateTo: query.paidDateTo ?? null,
      paidDateFrom: query.paidDateFrom ?? null,
    };
    const state = await this.mirrorState(tenantId);
    if (state.billCount === 0) {
      return {
        ...filters,
        officeName: office.officeName,
        rows: [],
        totalCents: null,
        dataAsOf: state.dataAsOf,
        available: false,
        message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    const built = this.buildBillsSql(
      query.type,
      office.officeCode,
      query.sId,
      query.year,
      query.feeCodes,
      query.natures,
      query.asOfPeriod,
      query.paidDateTo,
      query.paidDateFrom,
    );
    const raw: any[] = await this.dataSource.query(built.sql, built.params);
    const rows = raw.map((row) => ({
      zjId: Number(row.zjId),
      feeCode: row.feeCode == null ? null : String(row.feeCode),
      feeName: row.feeName == null ? null : String(row.feeName),
      period: row.period == null ? null : String(row.period),
      amountCents: Number(row.amountCents || 0),
      paidDate: row.paidDate == null ? null : String(row.paidDate),
      refundDate: row.refundDate == null ? null : String(row.refundDate),
      paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
      cashier: row.cashier == null ? null : String(row.cashier),
    }));
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return {
      ...filters,
      officeName: office.officeName,
      rows,
      totalCents,
      dataAsOf: state.dataAsOf,
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

  private async officeScope(tenantId: number, access?: ResolvedAccess) {
    const communities = await this.loadCommunities(tenantId);
    return resolveStatisticsOffices(communities, scopeCommunityIds(access));
  }

  private async requireOffice(tenantId: number, access: ResolvedAccess | undefined, officeCode: string) {
    const offices = await this.officeScope(tenantId, access);
    const office = offices.find((candidate) => candidate.officeCode === officeCode);
    if (!office) throw new ForbiddenException('该管理处不在你的数据范围内');
    return office;
  }

  /** 收费项目带旧系统分类；分类顺序 代收费/其它/日常收费/停车收费，同分类按 code。 */
  private async loadFeeItems(): Promise<StatisticsFeeItem[]> {
    const rows: any[] = await this.dataSource
      .query('SELECT fee_code AS "code", fee_name AS "name", category FROM mis_mirror_fee_item ORDER BY fee_code')
      .catch(() => []);
    return sortStatisticsFeeItems(rows.map((row) => ({
      code: String(row.code),
      name: String(row.name ?? ''),
      category: normalizeStatisticsFeeCategory(row.category == null ? null : String(row.category)),
    })));
  }

  /** 收款方式字典（镜像 mis_mirror_payment_method）；镜像为空返回 []。 */
  private async loadPaymentMethods(): Promise<Array<{ id: number; name: string }>> {
    const rows: any[] = await this.dataSource
      .query('SELECT method_id AS "id", method_name AS "name" FROM mis_mirror_payment_method ORDER BY method_id')
      .catch(() => []);
    return rows.map((row) => ({ id: Number(row.id), name: String(row.name ?? '') }));
  }

  private async loadYearRange(): Promise<{ min: number | null; max: number | null }> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT MIN(substr(period,1,4))::int AS "minYear", MAX(substr(period,1,4))::int AS "maxYear"
           FROM mis_mirror_bill WHERE period ~ '^[0-9]{6}$'`,
      )
      .catch(() => []);
    const row = rows[0] ?? {};
    return {
      min: row.minYear == null ? null : Number(row.minYear),
      max: row.maxYear == null ? null : Number(row.maxYear),
    };
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

  /** 年度汇总一条聚合 SQL：GROUP BY 管理处, 年度；不按年份逐个查。 */
  private buildAnnualSql(
    type: StatisticsType,
    officeCodes: string[],
    feeCodes: string[] | undefined,
    natures: string[] | undefined,
    yearFrom: number,
    yearTo: number,
    asOfPeriod?: string,
    paidDateTo?: string,
    paidDateFrom?: string,
  ): BuiltSql {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    where.push(`b.office_code IN (${officeCodes.map(add).join(',')})`);
    // 旧系统两张年度汇总都以「应收年月 period」归年：arrears 取未缴，received 取收款流水。
    where.push(`b.period ~ '^[0-9]{6}$'`);
    const yearExpr = 'substr(b.period,1,4)::int';
    if (type === 'arrears') {
      where.push('b.paid_date IS NULL');
    } else {
      where.push('b.paid_date IS NOT NULL');
    }
    where.push(`${yearExpr} BETWEEN ${add(yearFrom)} AND ${add(yearTo)}`);
    if (natures?.length) where.push(`TRIM(b.nature_code) IN (${natures.map(add).join(',')})`);
    if (feeCodes?.length) where.push(`b.fee_code IN (${feeCodes.map(add).join(',')})`);
    // 旧系统实收报表列到 2027/2028 且不按应收截止年月截断：asOfPeriod 只约束欠费口径。
    if (type === 'arrears' && asOfPeriod) where.push(`b.period <= ${add(asOfPeriod)}`);
    if (type === 'received' && paidDateTo) where.push(`b.paid_date <= ${add(paidDateTo)}`);
    if (type === 'received' && paidDateFrom) where.push(`b.paid_date >= ${add(paidDateFrom)}`);
    const sql = `SELECT b.office_code AS "officeCode", ${yearExpr} AS "year",
        COALESCE(SUM(b.amount_cents),0)::bigint AS "amountCents"
      FROM mis_mirror_bill b
      WHERE ${where.join(' AND ')}
      GROUP BY b.office_code, ${yearExpr}`;
    return { sql, params };
  }

  /** 欠费明细按房屋聚合一条 SQL（received 走 buildReceivedDetailSql 逐笔清单）；LEFT JOIN room 取面积。 */
  private buildDetailSql(
    type: StatisticsType,
    officeCode: string,
    year: number,
    feeCodes: string[] | undefined,
    natures: string[] | undefined,
    asOfPeriod?: string,
    paidDateTo?: string,
    paidDateFrom?: string,
  ): BuiltSql {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`b.office_code = ${add(officeCode)}`];
    if (type === 'arrears') {
      where.push('b.paid_date IS NULL');
      where.push(`b.period ~ '^[0-9]{6}$'`);
      where.push(`substr(b.period,1,4)::int = ${add(year)}`);
    } else {
      // 兜底：若将来复用本方法，received 也按应收年月归年。
      where.push('b.paid_date IS NOT NULL');
      where.push(`b.period ~ '^[0-9]{6}$'`);
      where.push(`substr(b.period,1,4)::int = ${add(year)}`);
    }
    if (natures?.length) where.push(`TRIM(b.nature_code) IN (${natures.map(add).join(',')})`);
    if (feeCodes?.length) where.push(`b.fee_code IN (${feeCodes.map(add).join(',')})`);
    // 旧系统实收报表列到 2027/2028 且不按应收截止年月截断：asOfPeriod 只约束欠费口径。
    if (type === 'arrears' && asOfPeriod) where.push(`b.period <= ${add(asOfPeriod)}`);
    if (type === 'received' && paidDateTo) where.push(`b.paid_date <= ${add(paidDateTo)}`);
    if (type === 'received' && paidDateFrom) where.push(`b.paid_date >= ${add(paidDateFrom)}`);
    const sql = `SELECT b.office_code AS "officeCode", b.s_id AS "sId",
        MAX(b.address) AS "address", MAX(b.owner_name) AS "ownerName",
        MAX(r.area_sqm)::float8 AS "areaSqm",
        MIN(b.period) AS "periodStart", MAX(b.period) AS "periodEnd",
        COALESCE(SUM(b.amount_cents),0)::bigint AS "amountCents"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_room r ON r.s_id = b.s_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.office_code, b.s_id
      ORDER BY MAX(b.address) NULLS LAST, b.s_id`;
    return { sql, params };
  }

  /**
   * 实收下钻：与单元格同一筛选条件下按「房屋 × 应收年月」聚合。
   * 旧系统把同户同月的成对「+126.50 / -126.50」冲抵行合并成一行显示 0.00；
   * zjId/收款方式/收款人/收据号/发票号聚合后无意义，统一返回 null。
   */
  private buildReceivedDetailSql(
    officeCode: string,
    year: number,
    feeCodes: string[] | undefined,
    natures: string[] | undefined,
    paidDateTo?: string,
    paidDateFrom?: string,
  ): BuiltSql {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [
      `b.office_code = ${add(officeCode)}`,
      'b.paid_date IS NOT NULL',
      `b.period ~ '^[0-9]{6}$'`,
      `substr(b.period,1,4)::int = ${add(year)}`,
    ];
    if (natures?.length) where.push(`TRIM(b.nature_code) IN (${natures.map(add).join(',')})`);
    if (feeCodes?.length) where.push(`b.fee_code IN (${feeCodes.map(add).join(',')})`);
    // 实收报表不按应收截止年月截断（旧系统列到 2027/2028）；asOfPeriod 收到也忽略。
    if (paidDateTo) where.push(`b.paid_date <= ${add(paidDateTo)}`);
    if (paidDateFrom) where.push(`b.paid_date >= ${add(paidDateFrom)}`);
    const sql = `SELECT b.s_id AS "sId",
        MAX(b.address) AS "address", MAX(b.owner_name) AS "ownerName",
        MAX(r.area_sqm)::float8 AS "areaSqm", b.period AS "period",
        COALESCE(SUM(b.amount_cents),0)::bigint AS "amountCents",
        to_char(MAX(b.paid_date),'YYYY-MM-DD') AS "paidDate",
        to_char(MAX(b.refund_date),'YYYY-MM-DD') AS "refundDate"
      FROM mis_mirror_bill b
      LEFT JOIN mis_mirror_room r ON r.s_id = b.s_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.s_id, b.period
      ORDER BY MAX(b.address) NULLS LAST, b.period`;
    return { sql, params };
  }

  /** 逐笔账单 SQL：与明细同一套筛选条件，合计必须等于房屋明细金额。 */
  private buildBillsSql(
    type: StatisticsType,
    officeCode: string,
    sId: number,
    year: number,
    feeCodes: string[] | undefined,
    natures: string[] | undefined,
    asOfPeriod?: string,
    paidDateTo?: string,
    paidDateFrom?: string,
  ): BuiltSql {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`b.office_code = ${add(officeCode)}`, `b.s_id = ${add(sId)}`];
    if (type === 'arrears') {
      where.push('b.paid_date IS NULL');
      where.push(`b.period ~ '^[0-9]{6}$'`);
      where.push(`substr(b.period,1,4)::int = ${add(year)}`);
    } else {
      where.push('b.paid_date IS NOT NULL');
      where.push(`b.period ~ '^[0-9]{6}$'`);
      where.push(`substr(b.period,1,4)::int = ${add(year)}`);
    }
    if (natures?.length) where.push(`TRIM(b.nature_code) IN (${natures.map(add).join(',')})`);
    if (feeCodes?.length) where.push(`b.fee_code IN (${feeCodes.map(add).join(',')})`);
    // 旧系统实收报表列到 2027/2028 且不按应收截止年月截断：asOfPeriod 只约束欠费口径。
    if (type === 'arrears' && asOfPeriod) where.push(`b.period <= ${add(asOfPeriod)}`);
    if (type === 'received' && paidDateTo) where.push(`b.paid_date <= ${add(paidDateTo)}`);
    if (type === 'received' && paidDateFrom) where.push(`b.paid_date >= ${add(paidDateFrom)}`);
    const sql = `SELECT b.zj_id AS "zjId", b.fee_code AS "feeCode", b.fee_name AS "feeName",
        b.period AS "period", b.amount_cents::bigint AS "amountCents",
        to_char(b.paid_date,'YYYY-MM-DD') AS "paidDate",
        to_char(b.refund_date,'YYYY-MM-DD') AS "refundDate",
        b.payment_method AS "paymentMethod", b.cashier AS "cashier"
      FROM mis_mirror_bill b
      WHERE ${where.join(' AND ')}
      ORDER BY b.period, b.zj_id`;
    return { sql, params };
  }
}
