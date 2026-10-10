import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  FEE_ITEM_CODES,
  FEE_PAYMENT_METHOD_VALUES,
  FeeBillSource,
  FeeBillStatus,
  FeeStandardStatus,
  OwnerSource,
  UserRole,
  UserStatus,
  feeItemName,
} from '../../common/enums';
import { addNaturalOrderBy } from '../../common/natural-order';
import { HouseIndex } from '../../common/house-index';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { Building, Community, FeeBill, FeeStandard, House, User } from '../../entities';
import {
  ArrearsQueryDto,
  CancelBillsDto,
  CreateCashierChargeDto,
  CreateBillDto,
  CreateStandardDto,
  FeeReportQueryDto,
  GenerateBillsDto,
  ImportFeesDto,
  ListBillsQueryDto,
  ListStandardsQueryDto,
  PageQueryDto,
  PayBillsDto,
  RefundReceiptDto,
  UpdateBillDto,
  UpdateStandardDto,
} from './dto';
import {
  assertReceiptRefundable,
  markRefundedRemark,
  mergeCashierContact,
  normalizeCashierContact,
  normalizeCashierItems,
  reversalRemark,
} from './cashier.util';
import {
  FEE_TZ,
  TrendGranularity,
  dayStart,
  daysBetween,
  foldToBuckets,
  growthRate,
  nextDayStart,
  previousRange,
  shareRatio,
  todayInTz,
  todayRange,
} from './report.util';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** 一次「生成账单」最多铺多少户，超过就说清楚而不是把库写爆 */
const GENERATE_LIMIT = 20000;

/**
 * 「几笔收款」：一张收据算一笔。
 * 旧库导入的明细可能没有收据号，那就按明细各算一笔 ——
 * COUNT(DISTINCT receipt_no) 会把 NULL 全丢掉，一整批历史收款会统计成 0 笔。
 */
const PAID_TXN_EXPR = `COUNT(DISTINCT COALESCE(f.receipt_no, 'bill#' || f.id))`;

/** 老库导进来的流水有的没记收款方式，对账表给它单独一列，不能默默并进「其他」 */
const UNKNOWN_METHOD = 'unknown';

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class FeesService {
  constructor(
    @InjectRepository(FeeBill)
    private readonly billRepo: Repository<FeeBill>,
    @InjectRepository(FeeStandard)
    private readonly standardRepo: Repository<FeeStandard>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  // ==================== 账单 ====================

  async listBills(
    query: ListBillsQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<PagedResult<any>> {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return this.emptyPage(query);

    const qb = this.billRepo
      .createQueryBuilder('f')
      .innerJoin(House, 'h', 'h.id = f.house_id AND h.tenant_id = f.tenant_id')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .where('f.tenant_id = :tenantId', { tenantId });

    this.applyBillFilters(qb, query, scope);

    const total = await qb.getCount();
    const { page, pageSize } = this.paging(query);

    qb.select([
      'f.id AS id',
      'f.house_id AS "houseId"',
      'f.community_id AS "communityId"',
      'f.owner_id AS "ownerId"',
      'f.owner_name AS "ownerName"',
      'f.fee_code AS "feeCode"',
      'f.fee_name AS "feeName"',
      'f.period AS period',
      'f.amount_cents AS "amountCents"',
      'f.quantity AS quantity',
      'f.unit AS unit',
      'f.unit_price_cents AS "unitPriceCents"',
      'f.service_from AS "serviceFrom"',
      'f.service_to AS "serviceTo"',
      'f.vehicle_plate AS "vehiclePlate"',
      'f.status AS status',
      'f.paid_at AS "paidAt"',
      'f.payment_method AS "paymentMethod"',
      'f.receipt_no AS "receiptNo"',
      'f.invoice_no AS "invoiceNo"',
      'f.cashier AS cashier',
      'f.remark AS remark',
      'f.source AS source',
      'c.name AS "communityName"',
      'b.lane AS lane',
      'b.building_no AS "buildingNo"',
      'h.room_no AS "roomNo"',
      'h.property_type AS "propertyType"',
    ])
      .orderBy('f.period', 'DESC')
      .addOrderBy('c.id', 'ASC');
    addNaturalOrderBy(qb, 'b.lane');
    addNaturalOrderBy(qb, 'b.building_no');
    addNaturalOrderBy(qb, 'h.room_no');
    qb.addOrderBy('f.id', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    const rows = await qb.getRawMany<any>();
    return {
      rows: rows.map((r) => this.mapBillRow(r)),
      total,
      page,
      pageSize,
    };
  }

  /** 当前筛选条件下的应收 / 实收 / 欠费合计（分），列表页顶部四个数用 */
  async billSummary(query: ListBillsQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) {
      return { billCount: 0, dueCents: 0, paidCents: 0, unpaidCents: 0, unpaidCount: 0 };
    }
    const qb = this.billRepo
      .createQueryBuilder('f')
      .innerJoin(House, 'h', 'h.id = f.house_id AND h.tenant_id = f.tenant_id')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .where('f.tenant_id = :tenantId', { tenantId });
    this.applyBillFilters(qb, query, scope);

    const raw = await qb
      .select('COUNT(*)', 'billCount')
      // 作废的账单不算应收 —— 免收/误生成的单子留痕但不该出现在欠费统计里
      .addSelect(
        `COALESCE(SUM(CASE WHEN f.status <> :cancelled THEN f.amount_cents ELSE 0 END), 0)`,
        'dueCents',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN f.status = :paid THEN f.amount_cents ELSE 0 END), 0)`,
        'paidCents',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN f.status = :unpaid THEN f.amount_cents ELSE 0 END), 0)`,
        'unpaidCents',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE f.status = :unpaid)`,
        'unpaidCount',
      )
      .setParameters({
        cancelled: FeeBillStatus.CANCELLED,
        paid: FeeBillStatus.PAID,
        unpaid: FeeBillStatus.UNPAID,
      })
      .getRawOne<any>();

    return {
      billCount: Number(raw?.billCount || 0),
      dueCents: Number(raw?.dueCents || 0),
      paidCents: Number(raw?.paidCents || 0),
      unpaidCents: Number(raw?.unpaidCents || 0),
      unpaidCount: Number(raw?.unpaidCount || 0),
    };
  }

  // ==================== 报表 ====================

  /**
   * 报表与对账共用的「实收」取数：paid_at 落在区间内、状态是已收或红冲的明细。
   *
   * fee_bills 上直接挂了 community_id，所以不用联房屋/楼栋/小区三张表，
   * 统计走单表扫描。筛选条件只认报表这几项，和账单列表那套刻意分开 ——
   * 账单列表按账期找单子，这里按钱什么时候到账找流水。
   */
  private paidBillsQuery(
    tenantId: number,
    scope: number[] | null,
    query: FeeReportQueryDto,
    rangeFrom: string,
    rangeTo: string,
  ) {
    const qb = this.billRepo
      .createQueryBuilder('f')
      .where('f.tenant_id = :tenantId', { tenantId })
      .andWhere('f.paid_at IS NOT NULL')
      .andWhere('f.status IN (:...paidStatuses)', {
        paidStatuses: [FeeBillStatus.PAID, FeeBillStatus.REFUNDED],
      })
      .andWhere('f.paid_at >= :rangeFrom AND f.paid_at < :rangeTo', {
        rangeFrom: dayStart(rangeFrom),
        rangeTo: nextDayStart(rangeTo),
      });
    if (scope) qb.andWhere('f.community_id IN (:...scopeIds)', { scopeIds: scope });
    if (query.communityId) qb.andWhere('f.community_id = :cid', { cid: query.communityId });
    if (query.feeCode) qb.andWhere('f.fee_code = :feeCode', { feeCode: query.feeCode });
    if (query.paymentMethod) qb.andWhere('f.payment_method = :pm', { pm: query.paymentMethod });
    return qb;
  }

  /**
   * 收费报表：总览（含环比）+ 趋势 + 收款方式 / 费用项目 / 小区 / 收费员分布。
   *
   * 口径只有一个：按 paid_at 落在区间内的实收明细统计，和账期无关
   * （12 月的房租 1 月才收，算 1 月的收入）。
   * 红冲的原单和负数红冲单都带 paid_at，两条相加为 0 —— 当天收完当天红冲
   * 等于没收，隔月红冲则冲减红冲发生那个月，和收费员手上的现金一致。
   */
  async feeReport(query: FeeReportQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    const { from, to } = this.reportRange(query);
    const granularity: TrendGranularity = query.granularity ?? 'day';
    const prev = previousRange(from, to);
    if (scope && !scope.length) return this.emptyReport(from, to, prev, granularity);

    const base = (rangeFrom: string, rangeTo: string) =>
      this.paidBillsQuery(tenantId, scope, query, rangeFrom, rangeTo);

    const totalsOf = async (rangeFrom: string, rangeTo: string) => {
      const raw = await base(rangeFrom, rangeTo)
        .select('COALESCE(SUM(f.amount_cents), 0)', 'netCents')
        .addSelect(
          'COALESCE(SUM(CASE WHEN f.amount_cents > 0 THEN f.amount_cents ELSE 0 END), 0)',
          'chargedCents',
        )
        .addSelect(
          'COALESCE(-SUM(CASE WHEN f.amount_cents < 0 THEN f.amount_cents ELSE 0 END), 0)',
          'refundedCents',
        )
        .addSelect(PAID_TXN_EXPR, 'receiptCount')
        .addSelect('COUNT(DISTINCT f.house_id)', 'houseCount')
        .addSelect('COUNT(*)', 'itemCount')
        .getRawOne<any>();
      return {
        netCents: Number(raw?.netCents || 0),
        chargedCents: Number(raw?.chargedCents || 0),
        refundedCents: Number(raw?.refundedCents || 0),
        receiptCount: Number(raw?.receiptCount || 0),
        houseCount: Number(raw?.houseCount || 0),
        itemCount: Number(raw?.itemCount || 0),
      };
    };

    const [totals, previous] = await Promise.all([
      totalsOf(from, to),
      totalsOf(prev.from, prev.to),
    ]);

    // 趋势只按上海自然日分组，周/月在 Node 里折 —— 边界算法只留一份
    const dayRows = await base(from, to)
      .select(`to_char(f.paid_at AT TIME ZONE '${FEE_TZ}', 'YYYY-MM-DD')`, 'day')
      .addSelect('COALESCE(SUM(f.amount_cents), 0)', 'amountCents')
      .addSelect(PAID_TXN_EXPR, 'count')
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<any>();

    const breakdown = async (
      expr: string,
      alias: string,
      tune?: (qb: SelectQueryBuilder<FeeBill>) => void,
    ) => {
      const qb = base(from, to)
        .select(expr, alias)
        .addSelect('COALESCE(SUM(f.amount_cents), 0)', 'amountCents')
        .addSelect(PAID_TXN_EXPR, 'count');
      tune?.(qb);
      // 按表达式分组而不是按别名：Postgres 会把未加引号的 feeCode 折成小写，
      // 和 TypeORM 输出的 "feeCode" 对不上就直接报列不存在
      return qb
        .groupBy(expr)
        .orderBy('"amountCents"', 'DESC')
        .getRawMany<any>();
    };

    const [methodRows, feeRows, communityRows, cashierRows] = await Promise.all([
      breakdown('f.payment_method', 'method'),
      breakdown('f.fee_code', 'feeCode', (qb) => {
        qb.addSelect('MAX(f.fee_name)', 'feeName');
      }),
      breakdown('f.community_id', 'communityId', (qb) => {
        qb.leftJoin(Community, 'c', 'c.id = f.community_id').addSelect('MAX(c.name)', 'communityName');
      }),
      breakdown('f.cashier', 'cashier'),
    ]);

    const share = (cents: number) => shareRatio(cents, totals.netCents);
    return {
      range: { from, to, granularity },
      previousRange: prev,
      totals,
      previous,
      growth: {
        netCents: growthRate(totals.netCents, previous.netCents),
        receiptCount: growthRate(totals.receiptCount, previous.receiptCount),
        houseCount: growthRate(totals.houseCount, previous.houseCount),
      },
      trend: foldToBuckets(
        dayRows.map((r) => ({
          day: r.day,
          amountCents: Number(r.amountCents || 0),
          count: Number(r.count || 0),
        })),
        from,
        to,
        granularity,
      ),
      byMethod: methodRows.map((r) => ({
        method: r.method ?? null,
        amountCents: Number(r.amountCents || 0),
        count: Number(r.count || 0),
        share: share(Number(r.amountCents || 0)),
      })),
      byFee: feeRows.map((r) => ({
        feeCode: r.feeCode,
        feeName: r.feeName ?? feeItemName(r.feeCode),
        amountCents: Number(r.amountCents || 0),
        count: Number(r.count || 0),
        share: share(Number(r.amountCents || 0)),
      })),
      byCommunity: communityRows.map((r) => ({
        communityId: r.communityId === null ? null : Number(r.communityId),
        communityName: r.communityName ?? null,
        amountCents: Number(r.amountCents || 0),
        count: Number(r.count || 0),
        share: share(Number(r.amountCents || 0)),
      })),
      byCashier: cashierRows.map((r) => ({
        cashier: r.cashier ?? null,
        amountCents: Number(r.amountCents || 0),
        count: Number(r.count || 0),
        share: share(Number(r.amountCents || 0)),
      })),
    };
  }

  private reportRange(query: FeeReportQueryDto) {
    const { from, to } = query;
    if (from > to) throw new BadRequestException('开始日期不能晚于截止日期');
    // 按天分桶，区间太长趋势图会糊成一片，也白查一堆数据
    if (daysBetween(from, to) > 1096) throw new BadRequestException('报表区间最长 3 年');
    return { from, to };
  }

  private emptyReport(
    from: string,
    to: string,
    prev: { from: string; to: string },
    granularity: TrendGranularity,
  ) {
    const zero = {
      netCents: 0,
      chargedCents: 0,
      refundedCents: 0,
      receiptCount: 0,
      houseCount: 0,
      itemCount: 0,
    };
    return {
      range: { from, to, granularity },
      previousRange: prev,
      totals: zero,
      previous: zero,
      growth: { netCents: null, receiptCount: null, houseCount: null },
      trend: foldToBuckets([], from, to, granularity),
      byMethod: [],
      byFee: [],
      byCommunity: [],
      byCashier: [],
    };
  }

  /**
   * 财务对账：按上海自然日 × 收款方式 的交叉表，每天一行，出纳拿它和现金、
   * 微信/支付宝账单逐日核。
   *
   * 和收费报表同一套取数口径（paidBillsQuery），所以两个页面的数字必然对得上；
   * 红冲单独成列，是为了解释「当天收了 5 笔、入账只有 4 笔的钱」是怎么回事。
   * 区间内没有收款的日子不补空行 —— 对账看的是有流水的那些天。
   */
  async feeReconciliation(query: FeeReportQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    const { from, to } = this.reportRange(query);
    const empty = { range: { from, to }, methods: [], rows: [], totals: this.emptyReconTotals() };
    if (scope && !scope.length) return empty;

    const raw = await this.paidBillsQuery(tenantId, scope, query, from, to)
      .select(`to_char(f.paid_at AT TIME ZONE '${FEE_TZ}', 'YYYY-MM-DD')`, 'day')
      .addSelect('f.payment_method', 'method')
      .addSelect('COALESCE(SUM(f.amount_cents), 0)', 'amountCents')
      .addSelect(
        'COALESCE(SUM(CASE WHEN f.amount_cents > 0 THEN f.amount_cents ELSE 0 END), 0)',
        'chargedCents',
      )
      .addSelect(
        'COALESCE(-SUM(CASE WHEN f.amount_cents < 0 THEN f.amount_cents ELSE 0 END), 0)',
        'refundedCents',
      )
      .addSelect(PAID_TXN_EXPR, 'count')
      .groupBy('day')
      .addGroupBy('f.payment_method')
      .orderBy('day', 'ASC')
      .getRawMany<any>();

    // 列顺序按预置的收款方式排，不按当天谁先出现 —— 否则两天的表头会不一样
    const seen = new Set<string>(raw.map((r) => r.method ?? UNKNOWN_METHOD));
    const methods = [
      ...FEE_PAYMENT_METHOD_VALUES.filter((m) => seen.has(m)),
      ...(seen.has(UNKNOWN_METHOD) ? [UNKNOWN_METHOD] : []),
    ];

    const byDay = new Map<string, ReturnType<FeesService['emptyReconRow']>>();
    const totals = this.emptyReconTotals();
    for (const r of raw) {
      const method = r.method ?? UNKNOWN_METHOD;
      const cell = {
        amountCents: Number(r.amountCents || 0),
        chargedCents: Number(r.chargedCents || 0),
        refundedCents: Number(r.refundedCents || 0),
        count: Number(r.count || 0),
      };
      const row = byDay.get(r.day) ?? this.emptyReconRow(r.day);
      row.byMethod[method] = cell;
      row.amountCents += cell.amountCents;
      row.chargedCents += cell.chargedCents;
      row.refundedCents += cell.refundedCents;
      row.count += cell.count;
      byDay.set(r.day, row);

      const sum = totals.byMethod[method] ?? { amountCents: 0, chargedCents: 0, refundedCents: 0, count: 0 };
      sum.amountCents += cell.amountCents;
      sum.chargedCents += cell.chargedCents;
      sum.refundedCents += cell.refundedCents;
      sum.count += cell.count;
      totals.byMethod[method] = sum;
      totals.amountCents += cell.amountCents;
      totals.chargedCents += cell.chargedCents;
      totals.refundedCents += cell.refundedCents;
      totals.count += cell.count;
    }

    return { range: { from, to }, methods, rows: [...byDay.values()], totals };
  }

  private emptyReconRow(day: string) {
    return {
      day,
      amountCents: 0,
      chargedCents: 0,
      refundedCents: 0,
      count: 0,
      byMethod: {} as Record<
        string,
        { amountCents: number; chargedCents: number; refundedCents: number; count: number }
      >,
    };
  }

  private emptyReconTotals() {
    const { byMethod, amountCents, chargedCents, refundedCents, count } = this.emptyReconRow('');
    return { amountCents, chargedCents, refundedCents, count, byMethod };
  }

  /** 欠费按户汇总：一户一行，欠多少个月、欠多少钱、最早欠到哪个账期 */
  async listArrears(
    query: ArrearsQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<PagedResult<any>> {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return this.emptyPage(query);

    const base = () => {
      const qb = this.billRepo
        .createQueryBuilder('f')
        .innerJoin(House, 'h', 'h.id = f.house_id AND h.tenant_id = f.tenant_id')
        .innerJoin(Building, 'b', 'b.id = h.building_id')
        .innerJoin(Community, 'c', 'c.id = b.community_id')
        .leftJoin(
          User,
          'u',
          'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :ownerRole',
          { ownerRole: UserRole.OWNER },
        )
        .where('f.tenant_id = :tenantId', { tenantId })
        .andWhere('f.status = :unpaid', { unpaid: FeeBillStatus.UNPAID });
      if (scope) qb.andWhere('f.community_id IN (:...scopeIds)', { scopeIds: scope });
      if (query.communityId) qb.andWhere('f.community_id = :cid', { cid: query.communityId });
      if (query.feeCode) qb.andWhere('f.fee_code = :feeCode', { feeCode: query.feeCode });
      if (query.q) this.applyKeyword(qb, query.q);
      return qb;
    };

    const countRow = await base()
      .select('COUNT(DISTINCT f.house_id)', 'total')
      .getRawOne<any>();
    const total = Number(countRow?.total || 0);
    const { page, pageSize } = this.paging(query);

    const qb = base()
      .select([
        'f.house_id AS "houseId"',
        'c.id AS "communityId"',
        'c.name AS "communityName"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'h.room_no AS "roomNo"',
        'h.property_type AS "propertyType"',
        'MAX(u.name) AS "ownerName"',
        'MAX(u.phone) AS "ownerPhone"',
        'COUNT(*) AS "billCount"',
        'SUM(f.amount_cents) AS "unpaidCents"',
        'MIN(f.period) AS "earliestPeriod"',
        'MAX(f.period) AS "latestPeriod"',
      ])
      .groupBy('f.house_id')
      .addGroupBy('c.id')
      .addGroupBy('c.name')
      .addGroupBy('b.lane')
      .addGroupBy('b.building_no')
      .addGroupBy('h.room_no')
      .addGroupBy('h.property_type')
      .orderBy('SUM(f.amount_cents)', 'DESC')
      .addOrderBy('f.house_id', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    const rows = await qb.getRawMany<any>();
    return {
      rows: rows.map((r) => ({
        houseId: Number(r.houseId),
        communityId: Number(r.communityId),
        communityName: r.communityName,
        lane: r.lane,
        buildingNo: r.buildingNo,
        roomNo: r.roomNo,
        propertyType: r.propertyType,
        ownerName: r.ownerName,
        ownerPhone: r.ownerPhone,
        billCount: Number(r.billCount),
        unpaidCents: Number(r.unpaidCents),
        earliestPeriod: r.earliestPeriod,
        latestPeriod: r.latestPeriod,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 一户的全部账单 + 当前收费标准（房产/欠费页点进去看明细） */
  async houseDetail(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.houseRepo
      .createQueryBuilder('h')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :ownerRole',
        { ownerRole: UserRole.OWNER },
      )
      .where('h.id = :houseId AND h.tenant_id = :tenantId', { houseId, tenantId })
      .select([
        'h.id AS id',
        'h.room_no AS "roomNo"',
        'h.property_type AS "propertyType"',
        'h.area_sqm AS "areaSqm"',
        'h.full_address AS "fullAddress"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'c.id AS "communityId"',
        'c.name AS "communityName"',
        'u.id AS "ownerId"',
        'u.name AS "ownerName"',
        'u.phone AS "ownerPhone"',
      ])
      .getRawOne<any>();
    if (!house) throw new NotFoundException('房产不存在');
    this.assertCommunityInScope(Number(house.communityId), access);

    const [bills, standards] = await Promise.all([
      this.billRepo.find({
        where: { tenantId, houseId },
        order: { period: 'DESC', id: 'DESC' },
        take: 600,
      }),
      this.standardRepo.find({
        where: { tenantId, houseId },
        order: { status: 'ASC', effectiveFrom: 'DESC', id: 'DESC' },
      }),
    ]);

    const unpaidCents = bills
      .filter((b) => b.status === FeeBillStatus.UNPAID)
      .reduce((sum, b) => sum + b.amountCents, 0);

    return {
      house: {
        id: Number(house.id),
        roomNo: house.roomNo,
        propertyType: house.propertyType,
        areaSqm: house.areaSqm,
        fullAddress: house.fullAddress,
        lane: house.lane,
        buildingNo: house.buildingNo,
        communityId: Number(house.communityId),
        communityName: house.communityName,
        owner: house.ownerId
          ? { id: Number(house.ownerId), name: house.ownerName, phone: house.ownerPhone }
          : null,
      },
      unpaidCents,
      bills,
      standards,
    };
  }

  /** 收费台的房间历史：一张收据一行，按实际收费时间倒序，固定 10 条分页。 */
  async cashierHistory(houseId: number, pageInput: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const place = await this.resolveHousePlace(tenantId, houseId);
    this.assertCommunityInScope(place.communityId, access);
    const page = Math.max(1, Number(pageInput) || 1);
    const pageSize = 10;
    const base = this.billRepo
      .createQueryBuilder('f')
      .where('f.tenant_id = :tenantId', { tenantId })
      .andWhere('f.house_id = :houseId', { houseId })
      .andWhere('f.receipt_no IS NOT NULL')
      .andWhere('f.paid_at IS NOT NULL');
    const count = await base.clone()
      .select('COUNT(DISTINCT f.receipt_no)', 'total')
      .getRawOne<{ total: string }>();
    const headers = await base.clone()
      .select('f.receipt_no', 'receiptNo')
      .addSelect('MAX(f.paid_at)', 'paidAt')
      .addSelect('MAX(f.payment_method)', 'paymentMethod')
      .addSelect('MAX(f.cashier)', 'cashier')
      .addSelect('MAX(f.remark)', 'remark')
      .addSelect('SUM(f.amount_cents)', 'amountCents')
      .addSelect(`BOOL_OR(f.status = '${FeeBillStatus.REFUNDED}')`, 'refunded')
      .groupBy('f.receipt_no')
      .orderBy('MAX(f.paid_at)', 'DESC')
      .addOrderBy('f.receipt_no', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<any>();
    const itemsByReceipt = await this.receiptItems(tenantId, headers.map((row) => row.receiptNo));
    return {
      rows: headers.map((row) => ({
        receiptNo: row.receiptNo,
        paidAt: row.paidAt,
        paymentMethod: row.paymentMethod,
        cashier: row.cashier,
        remark: row.remark,
        amountCents: Number(row.amountCents),
        status: row.refunded ? FeeBillStatus.REFUNDED : FeeBillStatus.PAID,
        items: itemsByReceipt.get(row.receiptNo) ?? [],
      })),
      total: Number(count?.total || 0),
      page,
      pageSize,
    };
  }

  /**
   * 今日收费流水：一张收据一行，按收费时间倒序。
   *
   * 合计把红冲产生的负数收据一并算进去 —— 当天收完又红冲的那笔自动抵消为 0，
   * 收费员手上的现金和这个数才对得上。
   */
  async cashierToday(query: PageQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    if (scope && !scope.length) return { rows: [], total: 0, page, pageSize, totalCents: 0 };

    const { from, to } = todayRange();
    const base = () => {
      const qb = this.billRepo
        .createQueryBuilder('f')
        .innerJoin(House, 'h', 'h.id = f.house_id AND h.tenant_id = f.tenant_id')
        .innerJoin(Building, 'b', 'b.id = h.building_id')
        .innerJoin(Community, 'c', 'c.id = b.community_id')
        .where('f.tenant_id = :tenantId', { tenantId })
        .andWhere('f.receipt_no IS NOT NULL')
        .andWhere('f.paid_at >= :from AND f.paid_at < :to', { from, to });
      if (scope) qb.andWhere('f.community_id IN (:...scopeIds)', { scopeIds: scope });
      return qb;
    };

    const summary = await base()
      .select('COUNT(DISTINCT f.receipt_no)', 'total')
      .addSelect('COALESCE(SUM(f.amount_cents), 0)', 'totalCents')
      .getRawOne<any>();
    const headers = await base()
      .select('f.receipt_no', 'receiptNo')
      .addSelect('f.house_id', 'houseId')
      .addSelect('c.name', 'communityName')
      .addSelect('b.lane', 'lane')
      .addSelect('b.building_no', 'buildingNo')
      .addSelect('h.room_no', 'roomNo')
      .addSelect('MAX(f.paid_at)', 'paidAt')
      .addSelect('MAX(f.payment_method)', 'paymentMethod')
      .addSelect('MAX(f.cashier)', 'cashier')
      .addSelect('MAX(f.owner_name)', 'ownerName')
      .addSelect('MAX(f.remark)', 'remark')
      .addSelect('SUM(f.amount_cents)', 'amountCents')
      .addSelect(`BOOL_OR(f.status = '${FeeBillStatus.REFUNDED}')`, 'refunded')
      .groupBy('f.receipt_no')
      .addGroupBy('f.house_id')
      .addGroupBy('c.name')
      .addGroupBy('b.lane')
      .addGroupBy('b.building_no')
      .addGroupBy('h.room_no')
      .orderBy('MAX(f.paid_at)', 'DESC')
      .addOrderBy('f.receipt_no', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<any>();

    const itemsByReceipt = await this.receiptItems(tenantId, headers.map((row) => row.receiptNo));
    return {
      rows: headers.map((row) => ({
        receiptNo: row.receiptNo,
        houseId: Number(row.houseId),
        communityName: row.communityName,
        lane: row.lane,
        buildingNo: row.buildingNo,
        roomNo: row.roomNo,
        ownerName: row.ownerName,
        paidAt: row.paidAt,
        paymentMethod: row.paymentMethod,
        cashier: row.cashier,
        remark: row.remark,
        amountCents: Number(row.amountCents),
        status: row.refunded ? FeeBillStatus.REFUNDED : FeeBillStatus.PAID,
        items: itemsByReceipt.get(row.receiptNo) ?? [],
      })),
      total: Number(summary?.total || 0),
      page,
      pageSize,
      totalCents: Number(summary?.totalCents || 0),
    };
  }

  /** 按收据号取整张收据，补打小票和红冲确认都用它。 */
  async cashierReceipt(receiptNo: string, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bills = await this.loadReceipt(tenantId, receiptNo, access);
    const head = bills[0];
    const place = await this.houseRepo
      .createQueryBuilder('h')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .where('h.id = :houseId AND h.tenant_id = :tenantId', { houseId: head.houseId, tenantId })
      .select([
        'c.name AS "communityName"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'h.room_no AS "roomNo"',
        'h.full_address AS "fullAddress"',
      ])
      .getRawOne<any>();
    const owner = head.ownerId
      ? await this.userRepo.findOne({ where: { id: head.ownerId, tenantId } })
      : null;
    return {
      receiptNo,
      houseId: head.houseId,
      communityName: place?.communityName ?? null,
      lane: place?.lane ?? null,
      buildingNo: place?.buildingNo ?? null,
      roomNo: place?.roomNo ?? null,
      fullAddress: place?.fullAddress ?? null,
      ownerName: head.ownerName ?? owner?.name ?? null,
      ownerPhone: owner?.phone ?? null,
      paidAt: head.paidAt,
      paymentMethod: head.paymentMethod,
      cashier: head.cashier,
      remark: head.remark,
      status: bills.some((bill) => bill.status === FeeBillStatus.REFUNDED)
        ? FeeBillStatus.REFUNDED
        : head.status,
      amountCents: bills.reduce((sum, bill) => sum + bill.amountCents, 0),
      items: bills.map((bill) => this.mapReceiptItem(bill)),
    };
  }

  /**
   * 整张收据红冲：原收据全部明细置红冲并留痕，另开一张金额取负的红冲收据。
   *
   * 不删除原收据 —— 已经打给住户的小票号必须查得到，而且两张单据相加为 0
   * 才能让当天流水、月报和对账同时对得上。
   */
  async refundReceipt(
    receiptNo: string,
    dto: RefundReceiptDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const bills = await this.loadReceipt(tenantId, receiptNo, access);
    assertReceiptRefundable(bills);
    const reversalNo = await this.nextReceiptNo(tenantId);
    const cashier = await this.operatorName(user.id);
    const now = new Date();
    const period = todayInTz(now).slice(0, 7).replace('-', '');
    const remark = reversalRemark(receiptNo, dto.reason);

    return this.dataSource.transaction(async (manager) => {
      const reversals = bills.map((bill) => manager.create(FeeBill, {
        tenantId,
        communityId: bill.communityId,
        houseId: bill.houseId,
        ownerId: bill.ownerId,
        ownerName: bill.ownerName,
        feeCode: bill.feeCode,
        feeName: bill.feeName,
        period,
        // 单价和数量保持正数，负号只由金额表达 —— 和旧库红冲明细同一口径。
        quantity: bill.quantity,
        unit: bill.unit,
        unitPriceCents: bill.unitPriceCents,
        amountCents: -bill.amountCents,
        serviceFrom: bill.serviceFrom,
        serviceTo: bill.serviceTo,
        vehiclePlate: bill.vehiclePlate,
        legacyPayload: null,
        status: FeeBillStatus.REFUNDED,
        paidAt: now,
        paymentMethod: bill.paymentMethod,
        receiptNo: reversalNo,
        invoiceNo: null,
        cashier,
        refundedAt: now,
        remark,
        source: FeeBillSource.MANUAL,
        standardId: null,
        legacyRef: null,
        createdBy: user.id,
        updatedBy: user.id,
      }));
      await manager.save(FeeBill, reversals);

      bills.forEach((bill) => {
        bill.status = FeeBillStatus.REFUNDED;
        bill.refundedAt = now;
        bill.remark = markRefundedRemark(bill.remark);
        bill.updatedBy = user.id;
      });
      await manager.save(FeeBill, bills);

      return {
        ok: true,
        receiptNo: reversalNo,
        originalReceiptNo: receiptNo,
        amountCents: reversals.reduce((sum, bill) => sum + bill.amountCents, 0),
        itemCount: reversals.length,
      };
    });
  }

  /** 公寓收费台：同步住户资料和记账必须同成同败。 */
  async createCashierCharge(
    dto: CreateCashierChargeDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const place = await this.resolveHousePlace(tenantId, dto.houseId);
    this.assertCommunityInScope(place.communityId, access);
    const items = normalizeCashierItems(dto.items);
    items.forEach((item) => this.assertFeeCode(item.feeCode));
    const contact = normalizeCashierContact(dto.ownerName, dto.ownerPhone);
    const receiptNo = await this.nextReceiptNo(tenantId);
    const cashier = await this.operatorName(user.id);
    const paidAt = dto.paidAt ? new Date(`${dto.paidAt}T12:00:00+08:00`) : new Date();
    const period = (dto.paidAt ?? todayInTz(paidAt)).slice(0, 7).replace('-', '');

    return this.dataSource.transaction(async (manager) => {
      let owner: User | null = null;
      if (dto.ownerId) {
        owner = await manager.findOne(User, {
          where: { id: dto.ownerId, tenantId, role: UserRole.OWNER, houseId: dto.houseId },
        });
        if (!owner) throw new BadRequestException('所选住户已不属于这个房间，请刷新后重试');
      } else {
        owner = await manager.findOne(User, {
          where: { tenantId, role: UserRole.OWNER, houseId: dto.houseId, status: UserStatus.ACTIVE },
          order: { id: 'ASC' },
        });
      }

      if (contact.phone && contact.phone !== owner?.phone) {
        const duplicate = await manager.findOne(User, {
          where: { tenantId, role: UserRole.OWNER, phone: contact.phone },
        });
        if (duplicate && duplicate.id !== owner?.id) {
          throw new BadRequestException('该手机号已登记在另一位业主名下，收费记录未保存');
        }
      }

      if (owner) {
        const mergedContact = mergeCashierContact(owner, contact);
        owner.name = mergedContact.name;
        owner.phone = mergedContact.phone;
        owner.updatedBy = user.id;
        await manager.save(User, owner);
      } else if (contact.name || contact.phone) {
        owner = await manager.save(User, manager.create(User, {
          tenantId,
          wxOpenid: null,
          wxUnionid: null,
          wxMpOpenid: null,
          name: contact.name,
          phone: contact.phone,
          wxNickname: null,
          passwordHash: null,
          loginAccount: null,
          role: UserRole.OWNER,
          houseId: dto.houseId,
          status: UserStatus.ACTIVE,
          source: OwnerSource.MANUAL,
          contactNote: null,
          legacyRef: null,
          createdBy: user.id,
          updatedBy: user.id,
        }));
      }

      const rows = items.map((item) => manager.create(FeeBill, {
        tenantId,
        communityId: place.communityId,
        houseId: dto.houseId,
        ownerId: owner?.id ?? null,
        ownerName: contact.name ?? owner?.name ?? null,
        feeCode: item.feeCode,
        feeName: feeItemName(item.feeCode),
        period,
        quantity: item.quantity,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
        serviceFrom: item.serviceFrom,
        serviceTo: item.serviceTo,
        vehiclePlate: item.vehiclePlate,
        legacyPayload: null,
        status: FeeBillStatus.PAID,
        paidAt,
        paymentMethod: dto.paymentMethod,
        receiptNo,
        invoiceNo: null,
        cashier,
        refundedAt: null,
        remark: [dto.remark?.trim(), item.remark].filter(Boolean).join('；') || null,
        source: FeeBillSource.MANUAL,
        standardId: null,
        legacyRef: null,
        createdBy: user.id,
        updatedBy: user.id,
      }));
      await manager.save(FeeBill, rows);
      return {
        ok: true,
        receiptNo,
        paidAt,
        ownerId: owner?.id ?? null,
        amountCents: rows.reduce((sum, item) => sum + item.amountCents, 0),
        itemCount: rows.length,
      };
    });
  }

  async createBill(dto: CreateBillDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const place = await this.resolveHousePlace(tenantId, dto.houseId);
    this.assertCommunityInScope(place.communityId, access);
    this.assertFeeCode(dto.feeCode);

    const dup = await this.billRepo.findOne({
      where: {
        tenantId,
        houseId: dto.houseId,
        feeCode: dto.feeCode,
        period: dto.period,
      },
    });
    if (dup) {
      throw new BadRequestException(
        `该房号 ${dto.period.slice(0, 4)}-${dto.period.slice(4)} 的${feeItemName(dto.feeCode)}账单已存在`,
      );
    }

    const bill = this.billRepo.create({
      tenantId,
      communityId: place.communityId,
      houseId: dto.houseId,
      ownerId: place.ownerId,
      ownerName: place.ownerName,
      feeCode: dto.feeCode,
      feeName: dto.feeName || feeItemName(dto.feeCode),
      period: dto.period,
      amountCents: dto.amountCents,
      status: FeeBillStatus.UNPAID,
      source: FeeBillSource.MANUAL,
      remark: dto.remark ?? null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.billRepo.save(bill);
  }

  async updateBill(id: number, dto: UpdateBillDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bill = await this.billRepo.findOne({ where: { id, tenantId } });
    if (!bill) throw new NotFoundException('账单不存在');
    this.assertCommunityInScope(bill.communityId, access);
    // 已收款的账单改金额会让「已收多少」对不上账，必须先撤销收款
    if (bill.status === FeeBillStatus.PAID && (dto.amountCents !== undefined || dto.period)) {
      throw new BadRequestException('已收款的账单不能改金额或账期，请先撤销收款');
    }
    if (dto.feeCode) {
      this.assertFeeCode(dto.feeCode);
      bill.feeCode = dto.feeCode;
      bill.feeName = feeItemName(dto.feeCode);
    }
    if (dto.period) bill.period = dto.period;
    if (dto.amountCents !== undefined) bill.amountCents = dto.amountCents;
    if (dto.remark !== undefined) bill.remark = dto.remark || null;
    bill.updatedBy = user.id;
    return this.billRepo.save(bill);
  }

  async deleteBill(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bill = await this.billRepo.findOne({ where: { id, tenantId } });
    if (!bill) throw new NotFoundException('账单不存在');
    this.assertCommunityInScope(bill.communityId, access);
    if (bill.status === FeeBillStatus.PAID) {
      throw new BadRequestException('已收款的账单不能删除，如需处理请先撤销收款或作废');
    }
    await this.billRepo.remove(bill);
    return { ok: true };
  }

  /** 批量登记收款：一次收几个月共用一个收据号 */
  async payBills(dto: PayBillsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bills = await this.billRepo.find({ where: { id: In(dto.ids), tenantId } });
    if (!bills.length) throw new NotFoundException('账单不存在');
    bills.forEach((b) => this.assertCommunityInScope(b.communityId, access));

    const alreadyPaid = bills.filter((b) => b.status === FeeBillStatus.PAID);
    const cancelled = bills.filter((b) => b.status === FeeBillStatus.CANCELLED);
    const target = bills.filter(
      (b) => b.status === FeeBillStatus.UNPAID || b.status === FeeBillStatus.REFUNDED,
    );
    if (!target.length) {
      throw new BadRequestException(
        cancelled.length
          ? '选中的账单已作废，请先恢复再收款'
          : '选中的账单都已收过款了',
      );
    }

    const cashier = await this.operatorName(user.id);
    const receiptNo = dto.receiptNo?.trim() || (await this.nextReceiptNo(tenantId));
    const paidAt = dto.paidAt ? new Date(`${dto.paidAt}T00:00:00+08:00`) : new Date();

    for (const bill of target) {
      bill.status = FeeBillStatus.PAID;
      bill.paidAt = paidAt;
      bill.paymentMethod = dto.paymentMethod;
      bill.receiptNo = receiptNo;
      bill.invoiceNo = dto.invoiceNo?.trim() || bill.invoiceNo;
      bill.cashier = cashier;
      bill.refundedAt = null;
      if (dto.remark) bill.remark = dto.remark;
      bill.updatedBy = user.id;
    }
    await this.billRepo.save(target);

    return {
      ok: true,
      paidCount: target.length,
      skippedPaid: alreadyPaid.length,
      skippedCancelled: cancelled.length,
      receiptNo,
      amountCents: target.reduce((sum, b) => sum + b.amountCents, 0),
    };
  }

  /** 撤销收款：收错了、退款了都走这里，账单回到未缴 */
  async unpayBills(dto: CancelBillsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bills = await this.billRepo.find({ where: { id: In(dto.ids), tenantId } });
    if (!bills.length) throw new NotFoundException('账单不存在');
    bills.forEach((b) => this.assertCommunityInScope(b.communityId, access));
    const target = bills.filter((b) => b.status === FeeBillStatus.PAID);
    if (!target.length) throw new BadRequestException('选中的账单没有已收款的');

    for (const bill of target) {
      bill.status = FeeBillStatus.UNPAID;
      bill.paidAt = null;
      bill.paymentMethod = null;
      bill.receiptNo = null;
      bill.cashier = null;
      if (dto.reason) bill.remark = `${bill.remark ? bill.remark + '；' : ''}撤销收款：${dto.reason}`;
      bill.updatedBy = user.id;
    }
    await this.billRepo.save(target);
    return { ok: true, count: target.length };
  }

  /** 作废（免收 / 误生成）：不计入应收，可恢复 */
  async cancelBills(dto: CancelBillsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bills = await this.billRepo.find({ where: { id: In(dto.ids), tenantId } });
    if (!bills.length) throw new NotFoundException('账单不存在');
    bills.forEach((b) => this.assertCommunityInScope(b.communityId, access));
    const target = bills.filter((b) => b.status !== FeeBillStatus.CANCELLED);
    const paid = target.filter((b) => b.status === FeeBillStatus.PAID);
    if (paid.length) {
      throw new BadRequestException(
        `选中的账单里有 ${paid.length} 条已收款，作废会让账对不上，请先撤销收款`,
      );
    }
    if (!target.length) throw new BadRequestException('选中的账单都已作废');

    for (const bill of target) {
      bill.status = FeeBillStatus.CANCELLED;
      if (dto.reason) bill.remark = `${bill.remark ? bill.remark + '；' : ''}作废：${dto.reason}`;
      bill.updatedBy = user.id;
    }
    await this.billRepo.save(target);
    return { ok: true, count: target.length };
  }

  /** 恢复作废的账单 */
  async restoreBills(dto: CancelBillsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const bills = await this.billRepo.find({ where: { id: In(dto.ids), tenantId } });
    if (!bills.length) throw new NotFoundException('账单不存在');
    bills.forEach((b) => this.assertCommunityInScope(b.communityId, access));
    const target = bills.filter((b) => b.status === FeeBillStatus.CANCELLED);
    if (!target.length) throw new BadRequestException('选中的账单没有已作废的');
    for (const bill of target) {
      bill.status = FeeBillStatus.UNPAID;
      bill.updatedBy = user.id;
    }
    await this.billRepo.save(target);
    return { ok: true, count: target.length };
  }

  /**
   * 按当前收费标准批量生成某个账期的账单。
   * 已存在的（同户+同项目+同账期）跳过，不覆盖 —— 重复点不会把已收的账单刷掉。
   */
  async generateBills(dto: GenerateBillsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.assertCommunityInScope(dto.communityId, access);
    if (dto.feeCode) this.assertFeeCode(dto.feeCode);

    // 账期首日：生效日期晚于账期的标准这次不参与
    const periodStart = `${dto.period.slice(0, 4)}-${dto.period.slice(4)}-01`;

    const standards = await this.standardRepo
      .createQueryBuilder('s')
      .where('s.tenant_id = :tenantId', { tenantId })
      .andWhere('s.community_id = :cid', { cid: dto.communityId })
      .andWhere('s.status = :active', { active: FeeStandardStatus.ACTIVE })
      .andWhere('s.amount_cents > 0')
      .andWhere('s.effective_from <= :periodStart', { periodStart })
      .andWhere('(s.effective_to IS NULL OR s.effective_to >= :periodStart)', { periodStart })
      .andWhere(dto.feeCode ? 's.fee_code = :feeCode' : '1=1', { feeCode: dto.feeCode })
      .orderBy('s.id', 'ASC')
      .limit(GENERATE_LIMIT + 1)
      .getMany();

    if (standards.length > GENERATE_LIMIT) {
      throw new BadRequestException(
        `该小区生效中的收费标准超过 ${GENERATE_LIMIT} 条，请按费用项目分批生成`,
      );
    }
    if (!standards.length) {
      return { created: 0, skipped: 0, amountCents: 0, message: '该小区没有生效中的收费标准' };
    }

    const existing = await this.billRepo
      .createQueryBuilder('f')
      .select(['f.house_id AS "houseId"', 'f.fee_code AS "feeCode"'])
      .where('f.tenant_id = :tenantId', { tenantId })
      .andWhere('f.community_id = :cid', { cid: dto.communityId })
      .andWhere('f.period = :period', { period: dto.period })
      .getRawMany<any>();
    const seen = new Set(existing.map((r) => `${r.houseId}|${r.feeCode}`));

    const owners = await this.userRepo
      .createQueryBuilder('u')
      .select(['u.id AS id', 'u.name AS name', 'u.house_id AS "houseId"'])
      .where('u.tenant_id = :tenantId', { tenantId })
      .andWhere('u.role = :ownerRole', { ownerRole: UserRole.OWNER })
      .andWhere('u.house_id IS NOT NULL')
      .getRawMany<any>();
    const ownerByHouse = new Map<number, { id: number; name: string | null }>();
    owners.forEach((o) => ownerByHouse.set(Number(o.houseId), { id: Number(o.id), name: o.name }));

    const toCreate: FeeBill[] = [];
    let skipped = 0;
    for (const std of standards) {
      const key = `${std.houseId}|${std.feeCode}`;
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const owner = ownerByHouse.get(std.houseId) ?? null;
      toCreate.push(
        this.billRepo.create({
          tenantId,
          communityId: std.communityId,
          houseId: std.houseId,
          ownerId: owner?.id ?? null,
          ownerName: owner?.name ?? null,
          feeCode: std.feeCode,
          feeName: std.feeName,
          period: dto.period,
          amountCents: std.amountCents,
          status: FeeBillStatus.UNPAID,
          source: FeeBillSource.GENERATED,
          standardId: std.id,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    }

    if (toCreate.length) {
      await this.billRepo.save(toCreate, { chunk: 500 });
    }
    return {
      created: toCreate.length,
      skipped,
      amountCents: toCreate.reduce((sum, b) => sum + b.amountCents, 0),
    };
  }

  // ==================== 收费标准 ====================

  async listStandards(
    query: ListStandardsQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<PagedResult<any>> {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return this.emptyPage(query);

    const qb = this.standardRepo
      .createQueryBuilder('s')
      .innerJoin(House, 'h', 'h.id = s.house_id AND h.tenant_id = s.tenant_id')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :ownerRole',
        { ownerRole: UserRole.OWNER },
      )
      .where('s.tenant_id = :tenantId', { tenantId });

    if (scope) qb.andWhere('s.community_id IN (:...scopeIds)', { scopeIds: scope });
    if (query.communityId) qb.andWhere('s.community_id = :cid', { cid: query.communityId });
    if (query.houseId) qb.andWhere('s.house_id = :hid', { hid: query.houseId });
    if (query.feeCode) qb.andWhere('s.fee_code = :feeCode', { feeCode: query.feeCode });
    // 默认只看当前生效的：历史标准是留痕用的，混在一起看不出现在到底收多少
    qb.andWhere('s.status = :status', { status: query.status || FeeStandardStatus.ACTIVE });
    if (query.q) this.applyKeyword(qb, query.q);

    const total = await qb.getCount();
    const { page, pageSize } = this.paging(query);

    qb.select([
      's.id AS id',
      's.house_id AS "houseId"',
      's.community_id AS "communityId"',
      's.fee_code AS "feeCode"',
      's.fee_name AS "feeName"',
      's.amount_cents AS "amountCents"',
      's.standard_cents AS "standardCents"',
      // 用 to_char 而不是直接取列：date 列走 getRawMany 会被 pg 驱动转成 JS Date，
      // 序列化成 UTC 之后 2019-01-01 会显示成 2018-12-31（差一天）。
      `to_char(s.effective_from, 'YYYY-MM-DD') AS "effectiveFrom"`,
      `to_char(s.effective_to, 'YYYY-MM-DD') AS "effectiveTo"`,
      's.status AS status',
      's.doc_no AS "docNo"',
      's.remark AS remark',
      'c.name AS "communityName"',
      'b.lane AS lane',
      'b.building_no AS "buildingNo"',
      'h.room_no AS "roomNo"',
      'h.property_type AS "propertyType"',
      'h.area_sqm AS "areaSqm"',
      'u.name AS "ownerName"',
      'u.phone AS "ownerPhone"',
    ]).orderBy('c.id', 'ASC');
    addNaturalOrderBy(qb, 'b.lane');
    addNaturalOrderBy(qb, 'b.building_no');
    addNaturalOrderBy(qb, 'h.room_no');
    qb.addOrderBy('s.fee_code', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    const rows = await qb.getRawMany<any>();
    return {
      rows: rows.map((r) => ({
        id: Number(r.id),
        houseId: Number(r.houseId),
        communityId: Number(r.communityId),
        communityName: r.communityName,
        lane: r.lane,
        buildingNo: r.buildingNo,
        roomNo: r.roomNo,
        propertyType: r.propertyType,
        areaSqm: r.areaSqm,
        ownerName: r.ownerName,
        ownerPhone: r.ownerPhone,
        feeCode: r.feeCode,
        feeName: r.feeName,
        amountCents: Number(r.amountCents),
        standardCents: r.standardCents == null ? null : Number(r.standardCents),
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        status: r.status,
        docNo: r.docNo,
        remark: r.remark,
      })),
      total,
      page,
      pageSize,
    };
  }

  async createStandard(dto: CreateStandardDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const place = await this.resolveHousePlace(tenantId, dto.houseId);
    this.assertCommunityInScope(place.communityId, access);
    this.assertFeeCode(dto.feeCode);

    return this.dataSource.transaction(async (manager) => {
      // 同一户同一项目只能有一条 active：新标准生效时把旧的转历史并封上失效日期
      const previous = await manager.find(FeeStandard, {
        where: {
          tenantId,
          houseId: dto.houseId,
          feeCode: dto.feeCode,
          status: FeeStandardStatus.ACTIVE,
        },
      });
      for (const old of previous) {
        old.status = FeeStandardStatus.HISTORY;
        old.effectiveTo = old.effectiveTo ?? this.dayBefore(dto.effectiveFrom);
        old.updatedBy = user.id;
      }
      if (previous.length) await manager.save(previous);

      return manager.save(
        manager.create(FeeStandard, {
          tenantId,
          communityId: place.communityId,
          houseId: dto.houseId,
          feeCode: dto.feeCode,
          feeName: dto.feeName || feeItemName(dto.feeCode),
          amountCents: dto.amountCents,
          standardCents: dto.standardCents ?? null,
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: null,
          status: FeeStandardStatus.ACTIVE,
          docNo: dto.docNo ?? null,
          remark: dto.remark ?? null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    });
  }

  async updateStandard(
    id: number,
    dto: UpdateStandardDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const std = await this.standardRepo.findOne({ where: { id, tenantId } });
    if (!std) throw new NotFoundException('收费标准不存在');
    this.assertCommunityInScope(std.communityId, access);

    if (dto.amountCents !== undefined) std.amountCents = dto.amountCents;
    if (dto.standardCents !== undefined) std.standardCents = dto.standardCents ?? null;
    if (dto.effectiveFrom) std.effectiveFrom = dto.effectiveFrom;
    if (dto.effectiveTo !== undefined) std.effectiveTo = dto.effectiveTo ?? null;
    if (dto.status) std.status = dto.status;
    if (dto.docNo !== undefined) std.docNo = dto.docNo ?? null;
    if (dto.remark !== undefined) std.remark = dto.remark ?? null;
    std.updatedBy = user.id;
    return this.standardRepo.save(std);
  }

  async deleteStandard(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const std = await this.standardRepo.findOne({ where: { id, tenantId } });
    if (!std) throw new NotFoundException('收费标准不存在');
    this.assertCommunityInScope(std.communityId, access);
    await this.standardRepo.remove(std);
    return { ok: true };
  }

  // ==================== 导入 ====================

  /**
   * 老系统数据导入（收费标准 + 历史账单）。
   * 按 legacy_ref 幂等：同一份数据重跑只更新、不建重。
   * 匹配不到房号的行不猜，原样返回给调用方（导入脚本会写进未匹配清单）。
   */
  async importFees(dto: ImportFeesDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    if (user.role !== UserRole.SUPERADMIN && !user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    const standards = dto.standards ?? [];
    const bills = dto.bills ?? [];
    const owners = dto.owners ?? [];
    if (!owners.length && !standards.length && !bills.length) {
      throw new BadRequestException('没有要导入的数据');
    }

    return this.dataSource.transaction(async (manager) => {
      const index = await HouseIndex.load(manager, tenantId);
      const result = {
        owners: { created: 0, updated: 0, unmatched: [] as string[], conflicts: [] as string[] },
        standards: { created: 0, updated: 0, unmatched: [] as string[] },
        bills: { created: 0, updated: 0, unmatched: [] as string[] },
      };

      // ---- 住户资料 ----
      if (owners.length) {
        const refs = owners.map((row) => row.legacyRef);
        const existingByRef = await manager.find(User, {
          where: { tenantId, role: UserRole.OWNER, legacyRef: In(refs) },
        });
        const byRef = new Map(existingByRef.map((owner) => [owner.legacyRef as string, owner]));
        const houseIds = Array.from(new Set(owners.map((row) => index.resolve(row.house)?.id).filter((id): id is number => !!id)));
        const existingByHouse = houseIds.length
          ? await manager.find(User, {
              where: { tenantId, role: UserRole.OWNER, status: UserStatus.ACTIVE, houseId: In(houseIds) },
              order: { id: 'ASC' },
            })
          : [];
        const byHouse = new Map<number, User[]>();
        existingByHouse.forEach((owner) => byHouse.set(owner.houseId as number, [...(byHouse.get(owner.houseId as number) ?? []), owner]));
        const toSave: User[] = [];
        for (const row of owners) {
          const house = index.resolve(row.house);
          if (!house) {
            result.owners.unmatched.push(HouseIndex.describe(row.house));
            continue;
          }
          const name = row.name?.trim() || null;
          const phone = row.phone?.trim() || null;
          let owner = byRef.get(row.legacyRef) ?? null;
          if (owner) {
            owner.houseId = house.id;
            if (name) owner.name = name;
            if (phone) owner.phone = phone;
            owner.source = OwnerSource.LEGACY_IMPORT;
            owner.updatedBy = user.id;
            result.owners.updated += 1;
          } else {
            const current = byHouse.get(house.id) ?? [];
            if (current.length > 1 || (current.length === 1 && (
              (name && current[0].name && name !== current[0].name)
              || (phone && current[0].phone && phone !== current[0].phone)
            ))) {
              result.owners.conflicts.push(HouseIndex.describe(row.house));
              continue;
            }
            if (current.length === 1) {
              owner = current[0];
              if (!owner.name && name) owner.name = name;
              if (!owner.phone && phone) owner.phone = phone;
              if (!owner.legacyRef) owner.legacyRef = row.legacyRef;
              owner.updatedBy = user.id;
              result.owners.updated += 1;
            } else {
              owner = manager.create(User, {
                tenantId,
                wxOpenid: null,
                wxUnionid: null,
                wxMpOpenid: null,
                name,
                phone,
                wxNickname: null,
                passwordHash: null,
                loginAccount: null,
                role: UserRole.OWNER,
                houseId: house.id,
                status: UserStatus.ACTIVE,
                source: OwnerSource.LEGACY_IMPORT,
                contactNote: null,
                legacyRef: row.legacyRef,
                createdBy: user.id,
                updatedBy: user.id,
              });
              byHouse.set(house.id, [owner]);
              result.owners.created += 1;
            }
          }
          byRef.set(row.legacyRef, owner);
          toSave.push(owner);
        }
        if (toSave.length) await manager.save(toSave, { chunk: 500 });
      }

      // ---- 收费标准 ----
      if (standards.length) {
        const refs = standards.map((r) => r.legacyRef);
        const existing = await manager.find(FeeStandard, {
          where: { tenantId, legacyRef: In(refs) },
        });
        const byRef = new Map(existing.map((s) => [s.legacyRef as string, s]));
        const toSave: FeeStandard[] = [];
        for (const row of standards) {
          const house = index.resolve(row.house);
          if (!house) {
            if (result.standards.unmatched.length < 200) {
              result.standards.unmatched.push(HouseIndex.describe(row.house));
            }
            continue;
          }
          const patch = {
            tenantId,
            communityId: house.communityId,
            houseId: house.id,
            feeCode: row.feeCode,
            feeName: row.feeName || feeItemName(row.feeCode),
            amountCents: row.amountCents,
            standardCents: row.standardCents ?? null,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo ?? null,
            status: row.status ?? FeeStandardStatus.ACTIVE,
            docNo: row.docNo ?? null,
            remark: row.remark ?? null,
            legacyRef: row.legacyRef,
            updatedBy: user.id,
          };
          const found = byRef.get(row.legacyRef);
          if (found) {
            Object.assign(found, patch);
            toSave.push(found);
            result.standards.updated += 1;
          } else {
            toSave.push(manager.create(FeeStandard, { ...patch, createdBy: user.id }));
            result.standards.created += 1;
          }
        }
        if (toSave.length) await manager.save(toSave, { chunk: 500 });
      }

      // ---- 账单 ----
      if (bills.length) {
        const refs = bills.map((r) => r.legacyRef);
        const existing = await manager.find(FeeBill, {
          where: { tenantId, legacyRef: In(refs) },
        });
        const byRef = new Map(existing.map((b) => [b.legacyRef as string, b]));

        // 账单要带上「这户现在绑的业主」，一次查完，别每行去查一次
        const houseIds = Array.from(
          new Set(
            bills
              .map((r) => index.resolve(r.house)?.id)
              .filter((id): id is number => !!id),
          ),
        );
        const ownerByHouse = new Map<number, { id: number; name: string | null }>();
        for (let i = 0; i < houseIds.length; i += 1000) {
          const chunk = houseIds.slice(i, i + 1000);
          const owners = await manager
            .createQueryBuilder(User, 'u')
            .select(['u.id AS id', 'u.name AS name', 'u.house_id AS "houseId"'])
            .where('u.tenant_id = :tenantId', { tenantId })
            .andWhere('u.role = :ownerRole', { ownerRole: UserRole.OWNER })
            .andWhere('u.house_id IN (:...ids)', { ids: chunk })
            .getRawMany<any>();
          owners.forEach((o) =>
            ownerByHouse.set(Number(o.houseId), { id: Number(o.id), name: o.name }),
          );
        }

        const toSave: FeeBill[] = [];
        for (const row of bills) {
          const house = index.resolve(row.house);
          if (!house) {
            if (result.bills.unmatched.length < 200) {
              result.bills.unmatched.push(HouseIndex.describe(row.house));
            }
            continue;
          }
          const owner = ownerByHouse.get(house.id) ?? null;
          const patch = {
            tenantId,
            communityId: house.communityId,
            houseId: house.id,
            ownerId: owner?.id ?? null,
            // 缴费人姓名以导入数据里的当年记录为准，没有才回落到现在的业主
            ownerName: row.ownerName ?? owner?.name ?? null,
            feeCode: row.feeCode,
            feeName: row.feeName || feeItemName(row.feeCode),
            period: row.period,
            amountCents: row.amountCents,
            quantity: row.quantity === undefined || row.quantity === null
              ? null
              : Number(row.quantity).toFixed(3),
            unit: row.unit ?? null,
            unitPriceCents: row.unitPriceCents ?? null,
            serviceFrom: row.serviceFrom ?? null,
            serviceTo: row.serviceTo ?? null,
            vehiclePlate: row.vehiclePlate ?? null,
            legacyPayload: row.legacyPayload ?? null,
            status: row.status ?? FeeBillStatus.UNPAID,
            paidAt: row.paidAt ? new Date(row.paidAt) : null,
            paymentMethod: row.paymentMethod ?? null,
            receiptNo: row.receiptNo ?? null,
            invoiceNo: row.invoiceNo ?? null,
            cashier: row.cashier ?? null,
            refundedAt: row.refundedAt ? new Date(row.refundedAt) : null,
            remark: row.remark ?? null,
            source: FeeBillSource.LEGACY_IMPORT,
            legacyRef: row.legacyRef,
            updatedBy: user.id,
          };
          const found = byRef.get(row.legacyRef);
          if (found) {
            Object.assign(found, patch);
            toSave.push(found);
            result.bills.updated += 1;
          } else {
            toSave.push(manager.create(FeeBill, { ...patch, createdBy: user.id }));
            result.bills.created += 1;
          }
        }
        if (toSave.length) await manager.save(toSave, { chunk: 500 });
      }

      return result;
    });
  }

  // ==================== 内部工具 ====================

  private applyBillFilters(
    qb: SelectQueryBuilder<FeeBill>,
    query: ListBillsQueryDto | ArrearsQueryDto,
    scope: number[] | null,
  ) {
    const q = query as ListBillsQueryDto;
    if (scope) qb.andWhere('f.community_id IN (:...scopeIds)', { scopeIds: scope });
    if (q.communityId) qb.andWhere('f.community_id = :cid', { cid: q.communityId });
    if (q.buildingId) qb.andWhere('h.building_id = :bid', { bid: q.buildingId });
    if (q.houseId) qb.andWhere('f.house_id = :hid', { hid: q.houseId });
    if (q.feeCode) qb.andWhere('f.fee_code = :feeCode', { feeCode: q.feeCode });
    if (q.status) qb.andWhere('f.status = :status', { status: q.status });
    if (q.periodFrom) qb.andWhere('f.period >= :pf', { pf: q.periodFrom });
    if (q.periodTo) qb.andWhere('f.period <= :pt', { pt: q.periodTo });
    // 收费时间按自然日闭区间给，查询用「次日 00:00 之前」，当天收的款不会被时分秒漏掉
    if (q.paidFrom) qb.andWhere('f.paid_at >= :paidFrom', { paidFrom: dayStart(q.paidFrom) });
    if (q.paidTo) qb.andWhere('f.paid_at < :paidTo', { paidTo: nextDayStart(q.paidTo) });
    if (q.paymentMethod) qb.andWhere('f.payment_method = :pm', { pm: q.paymentMethod });
    if (q.q) this.applyKeyword(qb, q.q);
  }

  /** 房号 / 业主 / 电话 / 收据号 的模糊搜索，账单和标准两边共用一套写法 */
  private applyKeyword(qb: SelectQueryBuilder<any>, keyword: string) {
    const raw = keyword.trim();
    const parts = raw.split(/[\/\\\-\s]+/).map((p) => p.trim()).filter(Boolean);
    const alias = qb.alias;
    const hasOwnerJoin = qb.expressionMap.aliases.some((a) => a.name === 'u');
    qb.andWhere(
      new Brackets((sub) => {
        sub
          .where('h.room_no ILIKE :kw', { kw: `%${raw}%` })
          .orWhere('b.lane ILIKE :kw', { kw: `%${raw}%` })
          .orWhere('b.building_no ILIKE :kw', { kw: `%${raw}%` })
          .orWhere('h.full_address ILIKE :kw', { kw: `%${raw}%` })
          .orWhere(
            "concat(coalesce(b.lane, ''), '弄', b.building_no, '号', h.room_no, '室') ILIKE :kw",
            { kw: `%${raw}%` },
          );
        if (alias === 'f') {
          sub
            .orWhere('f.owner_name ILIKE :kw', { kw: `%${raw}%` })
            .orWhere('f.receipt_no ILIKE :kw', { kw: `%${raw}%` });
        }
        if (hasOwnerJoin) {
          sub
            .orWhere('u.name ILIKE :kw', { kw: `%${raw}%` })
            .orWhere('u.phone ILIKE :kw', { kw: `%${raw}%` });
        }
        if (parts.length === 3) {
          sub.orWhere(
            'b.lane = :lanePart AND b.building_no = :bnoPart AND h.room_no = :roomPart',
            { lanePart: parts[0], bnoPart: parts[1], roomPart: parts[2] },
          );
        } else if (parts.length === 2) {
          sub.orWhere('b.building_no = :bnoPart2 AND h.room_no = :roomPart2', {
            bnoPart2: parts[0],
            roomPart2: parts[1],
          });
        }
      }),
    );
  }

  private async receiptItems(tenantId: number, receiptNos: string[]) {
    const byReceipt = new Map<string, ReturnType<FeesService['mapReceiptItem']>[]>();
    if (!receiptNos.length) return byReceipt;
    const bills = await this.billRepo.find({
      where: { tenantId, receiptNo: In(receiptNos) },
      order: { id: 'ASC' },
    });
    bills.forEach((bill) => {
      const key = bill.receiptNo as string;
      byReceipt.set(key, [...(byReceipt.get(key) ?? []), this.mapReceiptItem(bill)]);
    });
    return byReceipt;
  }

  private async loadReceipt(tenantId: number, receiptNo: string, access?: ResolvedAccess) {
    const bills = await this.billRepo.find({
      where: { tenantId, receiptNo },
      order: { id: 'ASC' },
    });
    if (!bills.length) throw new NotFoundException('收据不存在');
    this.assertCommunityInScope(bills[0].communityId, access);
    return bills;
  }

  private mapReceiptItem(bill: FeeBill) {
    return {
      id: bill.id,
      feeCode: bill.feeCode,
      feeName: bill.feeName,
      quantity: bill.quantity === null ? null : Number(bill.quantity),
      unit: bill.unit,
      unitPriceCents: bill.unitPriceCents,
      amountCents: bill.amountCents,
      serviceFrom: bill.serviceFrom,
      serviceTo: bill.serviceTo,
      vehiclePlate: bill.vehiclePlate,
    };
  }

  private mapBillRow(r: any) {
    return {
      id: Number(r.id),
      houseId: Number(r.houseId),
      communityId: Number(r.communityId),
      communityName: r.communityName,
      lane: r.lane,
      buildingNo: r.buildingNo,
      roomNo: r.roomNo,
      propertyType: r.propertyType,
      ownerId: r.ownerId ? Number(r.ownerId) : null,
      ownerName: r.ownerName,
      feeCode: r.feeCode,
      feeName: r.feeName,
      period: r.period,
      amountCents: Number(r.amountCents),
      quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
      unit: r.unit ?? null,
      unitPriceCents: r.unitPriceCents === null || r.unitPriceCents === undefined ? null : Number(r.unitPriceCents),
      serviceFrom: r.serviceFrom ?? null,
      serviceTo: r.serviceTo ?? null,
      vehiclePlate: r.vehiclePlate ?? null,
      status: r.status,
      paidAt: r.paidAt,
      paymentMethod: r.paymentMethod,
      receiptNo: r.receiptNo,
      invoiceNo: r.invoiceNo,
      cashier: r.cashier,
      remark: r.remark,
      source: r.source,
    };
  }

  private paging(query: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE));
    return { page, pageSize };
  }

  private emptyPage(query: { page?: number; pageSize?: number }): PagedResult<any> {
    const { page, pageSize } = this.paging(query);
    return { rows: [], total: 0, page, pageSize };
  }

  private assertFeeCode(code: string) {
    if (!FEE_ITEM_CODES.includes(code)) {
      throw new BadRequestException(`未知的费用项目：${code}`);
    }
  }

  /** 房号 → 小区 + 当前业主，新建账单/标准时补齐随行字段 */
  private async resolveHousePlace(tenantId: number, houseId: number) {
    const row = await this.houseRepo
      .createQueryBuilder('h')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :ownerRole',
        { ownerRole: UserRole.OWNER },
      )
      .where('h.id = :houseId AND h.tenant_id = :tenantId', { houseId, tenantId })
      .select([
        'b.community_id AS "communityId"',
        'u.id AS "ownerId"',
        'u.name AS "ownerName"',
      ])
      .getRawOne<any>();
    if (!row) throw new NotFoundException('房产不存在');
    return {
      communityId: Number(row.communityId),
      ownerId: row.ownerId ? Number(row.ownerId) : null,
      ownerName: row.ownerName ?? null,
    };
  }

  private assertCommunityInScope(communityId: number, access?: ResolvedAccess) {
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(communityId)) {
      throw new ForbiddenException('该小区不在你的管理范围内');
    }
  }

  private async operatorName(userId: number): Promise<string | null> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return user?.name ?? user?.loginAccount ?? null;
  }

  /** 收据号：SJ + 年月日 + 当天序号，人能看懂、当天连续 */
  private async nextReceiptNo(tenantId: number): Promise<string> {
    const prefix = `SJ${todayInTz().replace(/-/g, '')}`;
    const row = await this.billRepo
      .createQueryBuilder('f')
      .select('MAX(f.receipt_no)', 'maxNo')
      .where('f.tenant_id = :tenantId', { tenantId })
      .andWhere('f.receipt_no LIKE :prefix', { prefix: `${prefix}%` })
      .getRawOne<any>();
    const seq = row?.maxNo ? Number(String(row.maxNo).slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(Number.isFinite(seq) ? seq : 1).padStart(4, '0')}`;
  }

  /** 'YYYY-MM-DD' 的前一天，用于把旧标准封到新标准生效前一日 */
  private dayBefore(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }
}
