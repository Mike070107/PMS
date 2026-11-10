/**
 * 统计汇总（旧「一通软件」统计菜单）前端共用类型与纯函数。
 * 金额一律是整数分；页面显示统一 ¥x,xxx.xx，CSV 用纯数字便于 Excel 计算。
 */

export type StatisticsReportType = 'received' | 'arrears' | 'fee-nature' | 'daily' | 'daily-fees' | 'arrears-prepaid' | 'assessment' | 'collection-analysis' | 'monthly-report' | 'property-summary' | 'owner-ledger' | 'building-ledger' | 'relief' | 'signoffs' | 'ticket-summary' | 'tickets' | 'ticket-items';
/** P1 年度报表：共用应收截止年月/收款日期等筛选。 */
export type AnnualReportType = 'received' | 'arrears';

export interface StatisticsOfficeOption {
  officeCode: string;
  name: string;
  communityId: number | null;
  communityName: string | null;
}
/** 收费项目分类（旧 MIS 分类树顺序）；后端 P1.2 起 feeItems 自带 category。 */
export const FEE_CATEGORY_ORDER = ['代收费', '其它', '日常收费', '停车收费'] as const;

/** 后端旧数据没有 category 时按收费项目 code 兜底归类（与旧 MIS 分类树一致）。 */
const FEE_CATEGORY_BY_CODE: Record<string, string> = {
  '12': '代收费', '13': '代收费',
  '09': '其它', '10': '其它', '11': '其它',
  '01': '日常收费', '02': '日常收费', '03': '日常收费', '06': '日常收费',
  '07': '日常收费', '08': '日常收费', '15': '日常收费',
  '04': '停车收费', '05': '停车收费', '14': '停车收费', '16': '停车收费',
};

export interface StatisticsFeeItem { code: string; name: string; category?: string | null }

export interface FeeCategoryGroup { category: string; items: StatisticsFeeItem[] }

/** 收费项目按分类树分组：按 FEE_CATEGORY_ORDER 排序，未知分类附在最后。 */
export function groupFeeItems(feeItems: StatisticsFeeItem[]): FeeCategoryGroup[] {
  const buckets = new Map<string, StatisticsFeeItem[]>();
  for (const item of feeItems) {
    const category = item.category || FEE_CATEGORY_BY_CODE[item.code] || '其它';
    const list = buckets.get(category);
    if (list) list.push(item);
    else buckets.set(category, [item]);
  }
  const extra = [...buckets.keys()].filter((category) => !(FEE_CATEGORY_ORDER as readonly string[]).includes(category));
  return [...FEE_CATEGORY_ORDER, ...extra]
    .filter((category) => buckets.has(category))
    .map((category) => ({ category, items: buckets.get(category) ?? [] }));
}

export interface StatisticsNatureOption { code: string; name: string }
export interface StatisticsOptions {
  offices: StatisticsOfficeOption[];
  feeItems: StatisticsFeeItem[];
  natures: StatisticsNatureOption[];
  yearRange: { min: number | null; max: number | null };
  dataAsOf: string | null;
  sourceMode: string;
  /** MIS 镜像是否可用；不可用时页面优先显示 message，而不是「暂无数据」。 */
  available?: boolean;
  message?: string | null;
  /** P2：收款方式字典（设备/旧系统都可能有空数组）。 */
  paymentMethods?: Array<{ id: string; name: string }>;
}

/** 年度 -> 分 */
export type AnnualCells = Record<string, number>;
export interface AnnualSummaryRow {
  officeCode: string;
  officeName: string;
  cells: AnnualCells;
  totalCents: number;
}
export interface AnnualSummaryResponse {
  type: StatisticsReportType;
  columns: number[];
  rows: AnnualSummaryRow[];
  /** 未镜像时后端返回 null，不伪造 0。 */
  subtotal: { cells: AnnualCells; totalCents: number } | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export interface AnnualDetailRow {
  /** 后端房屋 id 是数字（数据库为空时可能为 null，此时不能下钻逐笔）。 */
  sId: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | string | null;
  periodRange: string | null;
  amountCents: number;
}
/** 实收报表下钻的行：逐笔已收流水（旧系统「项目实收年度汇总」点单元格即逐笔清单）。 */
export interface AnnualReceivedDetailRow {
  zjId: string | number;
  sId?: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | string | null;
  /** 应收年月 YYYYMM（年度列按它的年份归年） */
  period: string | null;
  amountCents: number;
  paidDate: string | null;
  refundDate: string | null;
  paymentMethod: string | null;
  cashier: string | null;
  /** 旧系统/MIS 镜像暂无：null 显示「—」 */
  receiptNo?: string | null;
  invoiceNo?: string | null;
}

export interface AnnualDetailResponse {
  /** 实收=逐笔清单；欠费=按房屋聚合（兼容后端不带该字段的旧响应）。 */
  detailKind?: 'received' | 'arrears';
  rows: Array<AnnualDetailRow | AnnualReceivedDetailRow>;
  /** 未镜像时后端返回 null，不伪造 0。 */
  totalCents: number | null;
  /** 实收逐笔条数（后端可选返回）。 */
  count?: number | null;
  available?: boolean;
  message?: string | null;
}

export interface AnnualBillRow {
  zjId: string | number;
  feeCode?: string | null;
  feeName: string | null;
  period: string | null;
  amountCents: number;
  paidDate: string | null;
  refundDate: string | null;
  paymentMethod: string | null;
  cashier: string | null;
}
export interface AnnualBillsResponse {
  rows: AnnualBillRow[];
  totalCents: number | null;
  available?: boolean;
  message?: string | null;
}

/** 点「统计」时定格的筛选快照；下钻与导出都必须用它，不能读草稿。 */
export interface AnnualQuery {
  type: AnnualReportType;
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  /** 后端 yearRange 可能为 null：为 null 时不传，交给服务端默认。 */
  yearFrom: number | null;
  yearTo: number | null;
  /** 应收截止年月 YYYYMM（年度/明细/逐笔必须同一值，否则明细合计与单元格对不上） */
  asOfPeriod: string;
  /** 收款日期范围 YYYY-MM-DD，仅实收报表使用；空串 = 不限制 */
  paidDateFrom: string;
  paidDateTo: string;
}

/** P2 收费汇总（行=收费项目，列=房屋性质）。日期区间必填，所属年度为应收年可选。 */
export interface CollectionQuery {
  type: 'fee-nature';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  paymentMethods: string[];
  cashier: string;
  dateFrom: string;
  dateTo: string;
  subjectYearFrom: string;
  subjectYearTo: string;
}

/** P2 收款日报表（行=日期，列=收费项目）。日期区间必填。 */
export interface DailyQuery {
  type: 'daily' | 'daily-fees';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  dateFrom: string;
  dateTo: string;
}

/** P2-C 欠收与溢收汇总：统计年月 + 收款截止日期，两页签共用筛选。 */
export interface ArrearsPrepaidQuery {
  type: 'arrears-prepaid';
  tab: 'arrears' | 'prepaid';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  asOfPeriod: string;
  paidDateTo: string;
}

/** P2-C 收缴考核：统计年份（1–12 月）。 */
export interface AssessmentQuery {
  type: 'assessment';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  year: string;
  paidDateTo: string;
}

/** P2-D 收款分析（按户）：统计年月 + 收款日期区间 + 排序。 */
export interface CollectionAnalysisQuery {
  type: 'collection-analysis';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  asOfPeriod: string;
  dateFrom: string;
  dateTo: string;
  sort: 'currentArrears' | 'historyArrears' | 'address';
}

/** P2-D 收费月报表（核心指标版）：统计年月。 */
export interface MonthlyReportQuery {
  type: 'monthly-report';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  asOfPeriod: string;
}

/** P3-A 房产汇总：按管理处统计楼栋/房屋/业主/面积与各房屋性质房屋数。 */
export interface PropertySummaryQuery {
  type: 'property-summary';
  officeCodes: string[];
}
/** P3-A 住户台账：管理处 + 房屋性质 + 关键词分页。 */
export interface OwnerLedgerQuery {
  type: 'owner-ledger';
  officeCodes: string[];
  natures: string[];
  keyword: string;
}
/** P3-A 楼房台账：管理处 + 关键词分页。 */
export interface BuildingLedgerQuery {
  type: 'building-ledger';
  officeCodes: string[];
  keyword: string;
}

/** P4-A 减免情况统计：减免日期范围 + 管理处/收费项目 + 关键词分页。 */
export interface ReliefQuery {
  type: 'relief';
  officeCodes: string[];
  feeCodes: string[];
  dateFrom: string;
  dateTo: string;
  keyword: string;
}

/** P4-A 签报情况统计：拟稿日期范围 + 管理处/状态/类型 + 关键词分页。 */
export interface SignoffsQuery {
  type: 'signoffs';
  officeCodes: string[];
  types: string[];
  status: 'all' | 'effective' | 'voided' | 'open';
  dateFrom: string;
  dateTo: string;
  keyword: string;
}

/** P2-E 收款汇总表：费项×收款方式动态列 + 票据口径/按收款人副表。 */
export interface TicketSummaryQuery {
  type: 'ticket-summary';
  officeCodes: string[];
  feeCodes: string[];
  paymentMethods: string[];
  cashier: string;
  dateFrom: string;
  dateTo: string;
}
/** P2-E 票据情况统计：开票日期范围 + 状态/关键词分页。 */
export interface TicketListQuery {
  type: 'tickets';
  officeCodes: string[];
  status: 'all' | 'issued' | 'pre_issue' | 'voided' | 'written_off';
  keyword: string;
  dateFrom: string;
  dateTo: string;
}

export type ReportQuery = AnnualQuery | CollectionQuery | DailyQuery | ArrearsPrepaidQuery | AssessmentQuery | CollectionAnalysisQuery | MonthlyReportQuery | PropertySummaryQuery | OwnerLedgerQuery | BuildingLedgerQuery | ReliefQuery | SignoffsQuery | TicketSummaryQuery | TicketListQuery | TicketItemsQuery;

export interface TicketItemsQuery {
  type: 'ticket-items';
  officeCodes: string[];
  feeCodes: string[];
  dateFrom: string;
  dateTo: string;
}
export type TicketItemsGroup = 'fee' | 'office' | 'day';
export interface TicketItemsTotals {
  itemCount: number; ticketCount: number; amountCents: number; taxCents: number; incomeCents: number;
}
export interface TicketItemsCoverage {
  dateFrom: string | null; dateTo: string | null; itemCount: number; ticketCount: number;
  nonzeroTaxItemCount: number; unknownTaxItemCount: number;
}
export interface TicketItemsSummaryResponse {
  groupBy: TicketItemsGroup;
  rows: Array<TicketItemsTotals & { key: string; label: string }>;
  totals: TicketItemsTotals | null;
  coverage?: TicketItemsCoverage | null;
  available: boolean; message?: string | null; dataAsOf?: string | null;
}
export interface TicketItemRow {
  itemId: number; ticketId: number; ticketNo: string | null; warehouseNo: string | null;
  officeCode: string; officeName?: string | null; issueDate: string | null; invoiceNo: string | null;
  feeCode: string | null; feeName: string | null; itemName: string | null; project: string | null;
  amountCents: number | null; taxCents: number | null; incomeCents: number;
}
export interface TicketItemsDetailResponse {
  rows: TicketItemRow[]; totals: TicketItemsTotals | null; count?: number | null;
  ticket?: { id: number; ticketNo: string | null; payer: string | null; address: string | null; customerName: string | null; issueDate: string | null; officeName: string | null } | null;
  available: boolean; message?: string | null; dataAsOf?: string | null;
}
export function ticketItemsParams(query: TicketItemsQuery) {
  return { officeCodes: query.officeCodes.join(','), feeCodes: query.feeCodes.join(','),
    dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined };
}
/** 空 key 代表源数据缺失值，现有 API 不能精确表达该分组，禁止误钻为全部数据。 */
export function ticketItemsDrillQuery(query: TicketItemsQuery, group: TicketItemsGroup, key: string): TicketItemsQuery | null {
  if (!key) return null;
  return { ...query, officeCodes: group === 'office' ? [key] : [...query.officeCodes],
    feeCodes: group === 'fee' ? [key] : [...query.feeCodes],
    dateFrom: group === 'day' ? key : query.dateFrom, dateTo: group === 'day' ? key : query.dateTo };
}
export function ticketItemsCoverageText(coverage?: TicketItemsCoverage | null): string {
  if (!coverage) return '历史覆盖信息暂不可用。';
  if (!coverage.itemCount) return '所选管理处及收费项目尚无开票行。';
  const dates = coverage.dateFrom && coverage.dateTo ? `${coverage.dateFrom} 至 ${coverage.dateTo}` : '未记录开票日期';
  const tax = coverage.nonzeroTaxItemCount === 0 && coverage.unknownTaxItemCount === 0
    ? '；这些历史行的税额均为 0' : coverage.unknownTaxItemCount > 0 ? '；部分源税额缺失，汇总按源接口口径计算' : '';
  return `所选管理处及收费项目历史覆盖：${dates}，${coverage.ticketCount} 张 / ${coverage.itemCount} 行（不受日期筛选限制）${tax}。`;
}
function spreadsheetCsvCell(value: string): string {
  // Preserve numeric negative amounts, neutralize text that spreadsheet apps can execute.
  const safe = /^[\s]*[=+@-]/.test(value) && !/^-?\d+(?:\.\d+)?$/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
  return csvCell(safe);
}
export function ticketItemsCsv(report: TicketItemsSummaryResponse, query: TicketItemsQuery): string {
  const label = { fee: '收费项目', office: '管理处', day: '开票日期' }[report.groupBy];
  const lines: string[][] = [['开票数据统计'], ['口径', '源全部开票行（含作废/预开/核销），非有效净开票或收款'],
    ['管理处', query.officeCodes.join('、')], ['收费项目', query.feeCodes.join('、')],
    ['开票日期', query.dateFrom || '不限', query.dateTo || '不限'], ['数据截止', report.dataAsOf || ''],
    [ticketItemsCoverageText(report.coverage)], [], [label, '票据张数', '开票行数', '金额', '税额', '收入（金额－税额）']];
  for (const row of report.rows) lines.push([row.label, String(row.ticketCount), String(row.itemCount), centsForCsv(row.amountCents), centsForCsv(row.taxCents), centsForCsv(row.incomeCents)]);
  if (report.totals) { const t = report.totals; lines.push(['独立去重合计', String(t.ticketCount), String(t.itemCount), centsForCsv(t.amountCents), centsForCsv(t.taxCents), centsForCsv(t.incomeCents)]); }
  return '\uFEFF' + lines.map(line => line.map(spreadsheetCsvCell).join(',')).join('\r\n');
}
export function ticketItemDetailsCsv(report: TicketItemsDetailResponse, scope: string): string {
  const lines: string[][] = [['开票逐笔明细'], ['筛选范围', scope], ['口径', '源全部开票行，非有效净开票或收款'],
    ['数据截止', report.dataAsOf || ''], ['导出行数', String(report.rows.length)], [],
    ['票据编号', '管理处', '开票日期', '收费项目', '开票项目', '项目说明', '金额', '税额', '收入（金额－税额）', '入库单编号', '发票号']];
  for (const r of report.rows) lines.push([r.ticketNo || '', r.officeName || r.officeCode, r.issueDate || '', r.feeName || r.feeCode || '', r.itemName || '', r.project || '', r.amountCents == null ? '' : centsForCsv(r.amountCents), r.taxCents == null ? '' : centsForCsv(r.taxCents), centsForCsv(r.incomeCents), r.warehouseNo || '', r.invoiceNo || '']);
  if (report.totals) { const t = report.totals; lines.push(['全部明细合计', `${t.ticketCount} 张 / ${t.itemCount} 行`, '', '', '', '', centsForCsv(t.amountCents), centsForCsv(t.taxCents), centsForCsv(t.incomeCents)]); }
  return '\uFEFF' + lines.map(line => line.map(spreadsheetCsvCell).join(',')).join('\r\n');
}

export interface FilterDraft {
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  paidDateFrom: string;
  paidDateTo: string;
  asOfPeriod: string;
  /** P2：收款方式多选（来自 options.paymentMethods） */
  paymentMethods: string[];
  /** P2：收款人 */
  cashier: string;
  /** P2：收费汇总的所属年度起止（应收年月年份，空 = 不限） */
  subjectYearFrom: string;
  subjectYearTo: string;
  /** P2-C 收缴考核统计年份（默认今年） */
  assessmentYear: string;
  /** P2-D 收款分析排序（默认当年欠收降序） */
  analysisSort: 'currentArrears' | 'historyArrears' | 'address';
  /** P3-A 住户/楼房台账关键词 */
  ledgerKeyword: string;
  /** P4-A 签报类型多选（来自数据 distinct；空 = 全部） */
  signoffTypes: string[];
  /** P4-A 签报状态筛选 */
  signoffStatus: 'all' | 'effective' | 'voided' | 'open';
  /** P2-E 票据状态筛选 */
  ticketStatus: 'all' | 'issued' | 'pre_issue' | 'voided' | 'written_off';
}

export const REPORTS: Array<{ type: StatisticsReportType; name: string; hint: string }> = [
  { type: 'received', name: '项目实收年度汇总', hint: '按应收年月所属年度汇总已收流水（含退款标记行及负调整）' },
  { type: 'arrears', name: '项目欠费年度汇总', hint: '按所属年度汇总未缴金额（收款日期为空）' },
  { type: 'fee-nature', name: '收费汇总', hint: '按收款日期统计收款/退款/调整；行=收费项目、列=房屋性质；点单元格查逐笔明细' },
  { type: 'daily', name: '收款日报表', hint: '按收款日期逐日统计各收费项目收款；点单元格查当日收款明细' },
  { type: 'daily-fees', name: '日常收费项目收款日报表', hint: '日期×收费项目收款矩阵；退款/调整分列，所有金额可下钻；旧模板细节待核对' },
  { type: 'arrears-prepaid', name: '欠收与溢收汇总', hint: '按统计年月区分欠收/溢收（预收）明细；查看逐笔、可按管理处小计' },
  { type: 'assessment', name: '收缴考核', hint: '按年份 1–12 月应收/收款考核房屋收缴率；含按金额/按户数指标' },
  { type: 'collection-analysis', name: '收款分析', hint: '按户查看历年欠收/当年欠收/当月应收/预缴/区间实收；点行看逐笔' },
  { type: 'monthly-report', name: '收费月报表（核心指标）', hint: '按管理处 11 项核心指标（月应收/实收/欠收/预收/回收率）；其余列待旧系统截图确认' },
  { type: 'property-summary', name: '房产汇总', hint: '按管理处统计楼栋/房屋/业主/建筑面积及各房屋性质房屋数' },
  { type: 'owner-ledger', name: '住户台账', hint: '按管理处/房屋性质与关键词查住户（地址/房号/业主/电话）；分页导出' },
  { type: 'building-ledger', name: '楼房台账', hint: '按管理处与关键词查楼栋（房屋数/业主数/面积）；分页导出' },
  { type: 'relief', name: '减免情况统计', hint: '按减免日期/管理处/收费项目查减免记录（原应收/现应收/减免金额）；分页导出' },
  { type: 'signoffs', name: '签报情况统计', hint: '按拟稿日期/管理处/状态/类型查签报；含作废/结束/调整金额与状态标签' },
  { type: 'ticket-summary', name: '收款汇总表', hint: '费项×收款方式动态列，附票据口径与按收款人副表；按收款日期统计' },
  { type: 'ticket-items', name: '开票数据统计', hint: '按开票日期统计源开票行，支持收费项目/管理处/日期分组及逐笔下钻；非有效净开票口径' },
  { type: 'tickets', name: '票据情况统计', hint: '按开票日期/管理处/状态查票据（编号/入库单/金额/税额/作废/核销/发票号）' },
];

/** 旧系统里尚未接入的报表：只列灰字，不做假按钮，不伪造数据。 */
export const PENDING_REPORTS = [
  '应收帐销账情况',
  '物业收款汇总',
  '收退款明细统计',
  '月报表',
  '综合月报表 B/C',
  '分等综合月报表',
  '空房情况统计',
  '能耗环比分析图表',
  '能耗同比分析图表',
  '能耗分析统计图表',
  '收费标准汇总',
  '项目欠费统计',
  '项目欠费汇总统计',
  '项目溢收统计',
  '项目溢收汇总统计',

  '住户票据查询',
  '票据使用数量统计',
  '线上收费查询',
];

export function reportName(type: StatisticsReportType): string {
  return REPORTS.find((report) => report.type === type)?.name ?? '统计汇总';
}

/** 整数分 -> ¥745,182.10；空/非法一律按 0 显示，不显示空白。 */
export function fmtCents(cents?: number | null): string {
  const value = Number(cents);
  const amount = Number.isFinite(value) ? value : 0;
  return '¥' + (amount / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 建筑面积：79.67 ㎡；缺失不编造。 */
export function fmtArea(area?: number | string | null): string {
  if (area === null || area === undefined || area === '') return '—';
  const value = Number(area);
  return Number.isFinite(value) ? `${value.toFixed(2)} ㎡` : String(area);
}

/** YYYYMM -> YYYY-MM */
export function fmtPeriod(period?: string | null): string {
  const text = String(period ?? '').trim();
  return /^\d{6}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4)}` : (text || '—');
}

/** 年度汇总表请求参数（数组用逗号连接；空值交给 request 过滤）。 */
export function annualQueryParams(query: AnnualQuery) {
  return {
    type: query.type,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    yearFrom: query.yearFrom ?? undefined,
    yearTo: query.yearTo ?? undefined,
    // 实收报表列按应收年度展示、不受截止年月截断（旧系统 2027/2028 列仍有金额）；
    // 应收截止年月仅欠费报表生效。
    asOfPeriod: query.type === 'arrears' ? (query.asOfPeriod || undefined) : undefined,
    // 收款日期范围只对实收报表有意义；欠费报表不传，避免后端按收款日期过滤掉欠费行。
    paidDateFrom: query.type === 'received' ? (query.paidDateFrom || undefined) : undefined,
    paidDateTo: query.type === 'received' ? (query.paidDateTo || undefined) : undefined,
  };
}

/** 明细/逐笔参数：必须和年度请求带同一组 asOfPeriod / 收款日期范围，否则合计对不上。 */
export function detailQueryParams(base: {
  type: StatisticsReportType;
  officeCode: string;
  year: number;
  feeCodes: string[];
  natures: string[];
  asOfPeriod: string;
  paidDateFrom: string;
  paidDateTo: string;
}) {
  return {
    type: base.type,
    officeCode: base.officeCode,
    year: base.year,
    feeCodes: base.feeCodes.join(','),
    natures: base.natures.join(','),
    asOfPeriod: base.type === 'arrears' ? (base.asOfPeriod || undefined) : undefined,
    paidDateFrom: base.type === 'received' ? (base.paidDateFrom || undefined) : undefined,
    paidDateTo: base.type === 'received' ? (base.paidDateTo || undefined) : undefined,
  };
}

/** 年度单元格金额（分），缺失按 0。 */
export function cellCents(row: { cells?: AnnualCells | null }, year: number | string): number {
  const value = Number(row.cells?.[String(year)] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function csvCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function centsForCsv(cents: number | undefined | null): string {
  const value = Number(cents);
  return ((Number.isFinite(value) ? value : 0) / 100).toFixed(2);
}

export interface CsvContext {
  dataAsOf?: string | null;
  filters: AnnualQuery;
  offices?: StatisticsOfficeOption[];
  feeItems?: StatisticsFeeItem[];
  natures?: StatisticsNatureOption[];
}

// ───────────────────────── P2：收费汇总 / 收款日报表 ─────────────────────────

export interface P2Column { code: string; name: string }
export interface FeeNatureRow {
  feeCode: string;
  feeName: string;
  cells: AnnualCells;
  receivedCents: number;
  refundCents: number;
  adjustCents: number;
  netCents: number;
}
export interface FeeNatureResponse {
  columns: P2Column[];
  natures: P2Column[];
  rows: FeeNatureRow[];
  subtotal: FeeNatureRow | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface DailyRow { date: string; cells: AnnualCells; totalCents: number; refundCents?: number; adjustCents?: number }
export interface DailyResponse {
  columns: P2Column[];
  rows: DailyRow[];
  subtotal: { cells: AnnualCells; totalCents: number } | null;
  refundTotalCents?: number | null;
  adjustTotalCents?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface CollectionDetailRow {
  rowKind: 'received' | 'refund' | 'adjust';
  address: string | null;
  ownerName: string | null;
  feeCode?: string | null;
  feeName: string | null;
  natureCode?: string | null;
  natureName?: string | null;
  period: string | null;
  amountCents: number;
  paidDate: string | null;
  refundDate: string | null;
  paymentMethod: string | null;
  cashier: string | null;
}
export interface CollectionDetailResponse {
  rows: CollectionDetailRow[];
  /** 现行 API 返回分类 totals；兼容早期 totalCents 响应。 */
  totals?: { receivedCents: number; refundCents: number; adjustCents: number; netCents: number } | null;
  totalCents?: number | null;
  count?: number | null;
  available?: boolean;
  message?: string | null;
}

/** 退款列显示正数退款额，不取 netCents 的负数；未就绪不伪造 0。 */
export function collectionDetailTotal(response: CollectionDetailResponse, kind: CollectionDetailKind): number | null {
  if (response.available === false) return null;
  const key = ({ all: 'netCents', received: 'receivedCents', refund: 'refundCents', adjust: 'adjustCents' } as const)[kind];
  if (response.totals) return response.totals[key] ?? null;
  return response.totalCents ?? null;
}

/** 收费汇总请求参数（数组逗号连接；空值交给 request 过滤）。 */
export function collectionQueryParams(query: CollectionQuery) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    paymentMethods: query.paymentMethods.join(','),
    cashier: query.cashier.trim() || undefined,
    yearFrom: query.subjectYearFrom || undefined,
    yearTo: query.subjectYearTo || undefined,
  };
}

/** 收款日报表请求参数。 */
export function dailyQueryParams(query: DailyQuery) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
  };
}

export type CollectionDetailKind = 'all' | 'received' | 'refund' | 'adjust';

/** 收费汇总/日报表下钻参数：合计必须与所点单元格对得上，因此费项/性质/日期必须同源。 */
export function collectionDetailParams(base: ReportQuery, target: {
  feeCode?: string | null;
  natureCode?: string | null;
  kind?: CollectionDetailKind;
  date?: string | null;
}, offset = 0, limit = 200) {
  const query = base as CollectionQuery | DailyQuery;
  const dateFrom = target.date || ('dateFrom' in query ? query.dateFrom : '');
  const dateTo = target.date || ('dateTo' in query ? query.dateTo : '');
  return {
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: target.feeCode || query.feeCodes.join(','),
    natures: target.natureCode || query.natures.join(','),
    kind: target.kind || 'all',
    limit,
    offset,
  };
}

/** 收费汇总 -> CSV（表头/合计与页面一致；金额为纯数字）。 */
export function feeNatureCsv(report: FeeNatureResponse, filters: CollectionQuery, feeItems?: StatisticsFeeItem[]): string {
  const officeText = filters.officeCodes.join('/') || '全部';
  const paymentText = filters.paymentMethods.join('/') || '全部';
  const lines: string[][] = [
    ['统计汇总', '收费汇总'],
    ['数据截止', String(report.dataAsOf || '')],
    ['管理处', officeText],
    ['收费项目', filters.feeCodes.map((code) => feeItems?.find((item) => item.code === code)?.name || code).join('/') || '全部'],
    ['房屋性质', filters.natures.map((code) => report.natures.find((item) => item.code === code)?.name || code).join('/') || '全部'],
    ['收款方式', paymentText],
    ['收款人', filters.cashier || '全部'],
    ['收款日期范围', [filters.dateFrom, filters.dateTo].filter(Boolean).join('~')],
    ['所属年度', [filters.subjectYearFrom, filters.subjectYearTo].filter(Boolean).join('~') || '不限'],
    [],
    ['收费项目', ...report.columns.map((column) => `${column.code} ${column.name}`), '收款', '退款', '调整', '净额'],
  ];
  for (const row of report.rows) {
    lines.push([
      row.feeName || row.feeCode,
      ...report.columns.map((column) => centsForCsv(Number(row.cells?.[column.code] ?? 0))),
      centsForCsv(row.receivedCents), centsForCsv(row.refundCents), centsForCsv(row.adjustCents), centsForCsv(row.netCents),
    ]);
  }
  if (report.subtotal) {
    lines.push([
      '总计',
      ...report.columns.map((column) => centsForCsv(Number(report.subtotal?.cells?.[column.code] ?? 0))),
      centsForCsv(report.subtotal.receivedCents), centsForCsv(report.subtotal.refundCents),
      centsForCsv(report.subtotal.adjustCents), centsForCsv(report.subtotal.netCents),
    ]);
  }
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 收款日报表 -> CSV。 */
export function dailyCsv(report: DailyResponse, filters: DailyQuery, feeItems?: StatisticsFeeItem[]): string {
  const lines: string[][] = [
    ['统计汇总', reportName(filters.type)],
    ['口径', '收费项目列和收款合计仅含正收款；退款按退款日、调整按收款日另列，不是净收款'],
    ['房屋性质', filters.natures.join('/') || '全部'],
    ['数据截止', String(report.dataAsOf || '')],
    ['管理处', filters.officeCodes.join('/') || '全部'],
    ['收费项目', filters.feeCodes.map((code) => feeItems?.find((item) => item.code === code)?.name || code).join('/') || '全部'],
    ['日期范围', [filters.dateFrom, filters.dateTo].filter(Boolean).join('~')],
    [],
    ['日期', ...report.columns.map((column) => column.name), '收款合计', '退款', '调整'],
  ];
  for (const row of report.rows) {
    lines.push([row.date, ...report.columns.map((column) => centsForCsv(Number(row.cells?.[column.code] ?? 0))), centsForCsv(row.totalCents), row.refundCents == null ? '' : centsForCsv(row.refundCents), row.adjustCents == null ? '' : centsForCsv(row.adjustCents)]);
  }
  if (report.subtotal) {
    lines.push(['合计', ...report.columns.map((column) => centsForCsv(Number(report.subtotal?.cells?.[column.code] ?? 0))), centsForCsv(report.subtotal.totalCents), report.refundTotalCents == null ? '' : centsForCsv(report.refundTotalCents), report.adjustTotalCents == null ? '' : centsForCsv(report.adjustTotalCents)]);
  }
  return '\uFEFF' + lines.map((line) => line.map(spreadsheetCsvCell).join(',')).join('\r\n');
}


// ───────────────────────── P2-C：欠收与溢收汇总 / 收缴考核 ─────────────────────────

export interface ArrearsPrepaidTotal {
  arrearsCents: number;
  arrearsRows: number;
  prepaidCents: number;
  prepaidRows: number;
}
export interface ArrearsPrepaidOfficeRow extends ArrearsPrepaidTotal {
  officeCode: string;
  officeName?: string | null;
}
export interface ArrearsPrepaidSummaryResponse {
  rows: ArrearsPrepaidOfficeRow[];
  total: ArrearsPrepaidTotal | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface ArrearsPrepaidDetailRow {
  sId: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | string | null;
  feeCode: string;
  feeName: string | null;
  natureCode?: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  months: number;
  amountCents: number;
}
export interface ArrearsPrepaidDetailResponse {
  rows: ArrearsPrepaidDetailRow[];
  totals: { amountCents: number; rows: number } | null;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface ArrearsBillsRow {
  zjId: string | number;
  period: string | null;
  amountCents: number;
  paidDate: string | null;
  refundDate: string | null;
}
export interface ArrearsBillsResponse {
  rows: ArrearsBillsRow[];
  totalCents: number | null;
  available?: boolean;
  message?: string | null;
}
export interface AssessmentMonth {
  month: number | string;
  receivableCents: number;
  receivedCents: number;
}
export interface AssessmentRow {
  officeCode: string;
  officeName?: string | null;
  sId: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | string | null;
  months: AssessmentMonth[];
  totalReceivableCents: number;
  totalReceivedCents: number;
  ratePct: number;
}
export interface AssessmentSummary {
  receivableCents: number;
  receivedCents: number;
  ratePct: number;
  payableHouseholds: number;
  paidHouseholds: number;
  householdRatePct: number;
}
export interface AssessmentResponse {
  rows: AssessmentRow[];
  summary: AssessmentSummary | null;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

/** 欠收与溢收汇总：按管理处汇总小计（summary 接口）。 */
export function arrearsPrepaidSummaryParams(query: ArrearsPrepaidQuery) {
  return {
    asOfPeriod: query.asOfPeriod || undefined,
    paidDateTo: query.paidDateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    groupBy: 'office',
  };
}

export function arrearsPrepaidDetailParams(query: ArrearsPrepaidQuery, offset = 0, limit = 200) {
  return {
    tab: query.tab,
    asOfPeriod: query.asOfPeriod || undefined,
    paidDateTo: query.paidDateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    limit,
    offset,
  };
}

export function arrearsBillsParams(query: ArrearsPrepaidQuery, row: { sId: number | null; feeCode: string }) {
  return {
    tab: query.tab,
    sId: row.sId ?? undefined,
    feeCode: row.feeCode,
    asOfPeriod: query.asOfPeriod || undefined,
    paidDateTo: query.paidDateTo || undefined,
  };
}

/** 收缴考核请求参数（统计年份 1–12 月；paidDateTo 可选）。 */
export function assessmentQueryParams(query: AssessmentQuery, offset = 0, limit = 200) {
  return {
    year: query.year || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    paidDateTo: query.paidDateTo || undefined,
    limit,
    offset,
  };
}

/** 欠收与溢收明细 -> CSV（列与页面一致，含合计行）。 */
export function arrearsPrepaidCsv(report: ArrearsPrepaidDetailResponse, query: ArrearsPrepaidQuery): string {
  const tabName = query.tab === 'arrears' ? '欠收统计' : '溢收统计';
  const rangeLabel = query.tab === 'arrears' ? '欠费年月范围' : '收费年月范围';
  const lines: string[][] = [
    ['统计汇总', '欠收与溢收汇总', tabName],
    ['统计年月', query.asOfPeriod],
    ['收款截止日期', query.paidDateTo],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收费项目', query.feeCodes.join('/') || '全部'],
    [],
    ['序号', '地址', '姓名', '建筑面积', '收费项目', rangeLabel, '月份数', '金额', '说明'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.address || '', row.ownerName || '', row.areaSqm === null ? '' : String(row.areaSqm),
      row.feeName || row.feeCode,
      [fmtPeriod(row.periodFrom), fmtPeriod(row.periodTo)].filter((text) => text !== '—').join('~'),
      String(row.months), centsForCsv(row.amountCents), '—',
    ]);
  });
  if (report.totals) lines.push(['合计', '', '', '', '', '', String(report.totals.rows), centsForCsv(report.totals.amountCents), '']);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 收缴考核 -> CSV（24 个月度列 + 合计应收/已收/收缴率）。 */
export function assessmentCsv(report: AssessmentResponse, query: AssessmentQuery): string {
  const headers = ['地址', '住户', '建筑面积'];
  for (let month = 1; month <= 12; month += 1) headers.push(`${month}月应收`, `${month}月收款`);
  headers.push('合计应收', '合计已收', '收缴率');
  const lines: string[][] = [
    ['统计汇总', '收缴考核'],
    ['统计年份', query.year],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收费项目', query.feeCodes.join('/') || '全部'],
    ['收款截止日期', query.paidDateTo || ''],
    [],
    headers,
  ];
  const monthCents = (row: AssessmentRow, month: number, key: 'receivableCents' | 'receivedCents') => {
    const found = row.months.find((item) => String(item.month) === String(month));
    return Number(found?.[key] ?? 0);
  };
  for (const row of report.rows) {
    const line = [row.address || '', row.ownerName || '', row.areaSqm === null ? '' : String(row.areaSqm)];
    for (let month = 1; month <= 12; month += 1) line.push(centsForCsv(monthCents(row, month, 'receivableCents')), centsForCsv(monthCents(row, month, 'receivedCents')));
    line.push(centsForCsv(row.totalReceivableCents), centsForCsv(row.totalReceivedCents), `${(Number(row.ratePct) || 0).toFixed(2)}%`);
    lines.push(line);
  }
  if (report.summary) {
    const line = ['合计', '', ''];
    for (let month = 1; month <= 12; month += 1) {
      line.push(
        centsForCsv(report.rows.reduce((sum, row) => sum + monthCents(row, month, 'receivableCents'), 0)),
        centsForCsv(report.rows.reduce((sum, row) => sum + monthCents(row, month, 'receivedCents'), 0)),
      );
    }
    line.push(centsForCsv(report.summary.receivableCents), centsForCsv(report.summary.receivedCents), `${(Number(report.summary.ratePct) || 0).toFixed(2)}%`);
    lines.push(line);
  }
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

// ───────────────────────── P2-D：收款分析（按户） / 收费月报表（核心指标） ─────────────────────────

export interface CollectionAnalysisRow {
  sId: number | null;
  officeCode: string;
  officeName?: string | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | string | null;
  historyArrearsCents: number;
  currentYearArrearsCents: number;
  currentMonthReceivableCents: number;
  prepaidCents: number;
  periodReceivedCents: number;
}
export type CollectionAnalysisTotals = Omit<CollectionAnalysisRow, 'sId' | 'officeCode' | 'officeName' | 'address' | 'ownerName' | 'areaSqm'>;
export interface CollectionAnalysisResponse {
  rows: CollectionAnalysisRow[];
  totals: CollectionAnalysisTotals | null;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface CollectionAnalysisDetailRow {
  zjId: string | number;
  period: string | null;
  amountCents: number;
  paidDate: string | null;
  refundDate: string | null;
  paymentMethod: string | null;
  cashier: string | null;
  feeCode?: string | null;
  feeName: string | null;
  natureCode?: string | null;
  rowKind: 'received' | 'refund' | 'adjust' | 'unpaid';
}
export interface CollectionAnalysisDetailResponse {
  rows: CollectionAnalysisDetailRow[];
  totals: { receivedCents?: number; refundCents?: number; adjustCents?: number; unpaidCents?: number; amountCents?: number; rows?: number } | null;
  count?: number | null;
  available?: boolean;
  message?: string | null;
}

export interface MonthlyReportRow {
  key: string;
  label: string;
  monthReceivableCents: number;
  monthAdjustCents: number;
  cumulativeReceivableCents: number;
  oldArrearsReceivableCents: number;
  totalReceivableCents: number;
  monthReceivedCents: number;
  prepaidInCents: number;
  prepaidBalanceCents: number;
  monthArrearsCents: number;
  cumulativeArrearsCents: number;
  recoveryRatePct: number;
}
export type MonthlyReportTotals = Omit<MonthlyReportRow, 'key' | 'label'>;
export interface MonthlyReportResponse {
  rows: MonthlyReportRow[];
  totals: MonthlyReportTotals | null;
  pendingColumns?: string[];
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export function collectionAnalysisParams(query: CollectionAnalysisQuery, offset = 0, limit = 200) {
  return {
    asOfPeriod: query.asOfPeriod || undefined,
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    sort: query.sort,
    limit,
    offset,
  };
}

export function collectionAnalysisDetailParams(query: CollectionAnalysisQuery, sId: number | null) {
  return {
    asOfPeriod: query.asOfPeriod || undefined,
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    sId: sId ?? undefined,
    limit: 200,
    offset: 0,
  };
}

export function monthlyReportParams(query: MonthlyReportQuery) {
  return {
    asOfPeriod: query.asOfPeriod || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    natures: query.natures.join(','),
    groupBy: 'office',
  };
}

/** 收款分析 -> CSV。 */
export function collectionAnalysisCsv(report: CollectionAnalysisResponse, query: CollectionAnalysisQuery): string {
  const lines: string[][] = [
    ['统计汇总', '收款分析（按户）'],
    ['统计年月', query.asOfPeriod],
    ['收款日期范围', [query.dateFrom, query.dateTo].filter(Boolean).join('~')],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收费项目', query.feeCodes.join('/') || '全部'],
    [],
    ['序号', '地址', '业主', '建筑面积', '历年欠收', '当年欠收', '当月应收', '预缴', '区间实收'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.address || '', row.ownerName || '', row.areaSqm === null ? '' : String(row.areaSqm),
      centsForCsv(row.historyArrearsCents), centsForCsv(row.currentYearArrearsCents), centsForCsv(row.currentMonthReceivableCents),
      centsForCsv(row.prepaidCents), centsForCsv(row.periodReceivedCents),
    ]);
  });
  if (report.totals) lines.push(['合计', '', '', '', centsForCsv(report.totals.historyArrearsCents), centsForCsv(report.totals.currentYearArrearsCents), centsForCsv(report.totals.currentMonthReceivableCents), centsForCsv(report.totals.prepaidCents), centsForCsv(report.totals.periodReceivedCents)]);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 收费月报表（核心指标） -> CSV。 */
export function monthlyReportCsv(report: MonthlyReportResponse, query: MonthlyReportQuery): string {
  const lines: string[][] = [
    ['统计汇总', '收费月报表（核心指标）'],
    ['统计年月', query.asOfPeriod],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收费项目', query.feeCodes.join('/') || '全部'],
    ['说明', '核心指标版：另有本期实收分项/累计实收/账面累计实收等列待旧系统截图确认，暂不显示'],
    [],
    ['管理处', '月应收', '月调整', '累计应收', '旧欠应收', '合计应收', '本期实收', '预收转入', '预收余额', '当月欠收', '累计欠收', '本期回收率'],
  ];
  const part = (row: MonthlyReportTotals) => [
    centsForCsv(row.monthReceivableCents), centsForCsv(row.monthAdjustCents), centsForCsv(row.cumulativeReceivableCents),
    centsForCsv(row.oldArrearsReceivableCents), centsForCsv(row.totalReceivableCents), centsForCsv(row.monthReceivedCents),
    centsForCsv(row.prepaidInCents), centsForCsv(row.prepaidBalanceCents), centsForCsv(row.monthArrearsCents),
    centsForCsv(row.cumulativeArrearsCents), `${(Number(row.recoveryRatePct) || 0).toFixed(2)}%`,
  ];
  for (const row of report.rows) lines.push([row.label || row.key, ...part(row)]);
  if (report.totals) lines.push(['合计', ...part(report.totals)]);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

// ───────────────────────── P3-A：房产汇总 / 住户台账 / 楼房台账 ─────────────────────────

export interface PropertySummaryCounts {
  buildingCount: number;
  roomCount: number;
  ownerCount: number;
  totalAreaSqm: number | string;
  natureCounts: Record<string, number>;
}
export interface PropertySummaryRow extends PropertySummaryCounts {
  officeCode: string;
  officeName?: string | null;
}
export interface PropertySummaryResponse {
  rows: PropertySummaryRow[];
  total: PropertySummaryCounts | null;
  natures: P2Column[];
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface OwnerLedgerRow {
  sId: number | null;
  officeCode: string;
  officeName?: string | null;
  address: string | null;
  road?: string | null;
  lane?: string | null;
  buildingNo?: string | null;
  roomNo?: string | null;
  natureCode?: string | null;
  natureName?: string | null;
  areaSqm: number | string | null;
  ownerName: string | null;
  mobile?: string | null;
  phone2?: string | null;
}
export interface OwnerLedgerResponse {
  rows: OwnerLedgerRow[];
  count?: number | null;
  totals?: { roomCount?: number; areaSqm?: number | string } | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}
export interface BuildingLedgerRow {
  lId: number | null;
  officeCode: string;
  officeName?: string | null;
  road?: string | null;
  lane?: string | null;
  buildingNo?: string | null;
  roomCount: number;
  areaSqm: number | string;
  ownerCount: number;
}
export interface BuildingLedgerResponse {
  rows: BuildingLedgerRow[];
  count?: number | null;
  totals?: { buildingCount?: number; roomCount?: number; ownerCount?: number; areaSqm?: number | string } | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export function propertySummaryParams(query: PropertySummaryQuery) {
  return { officeCodes: query.officeCodes.join(',') };
}
export function ownerLedgerParams(query: OwnerLedgerQuery, offset = 0, limit = 200) {
  return {
    officeCodes: query.officeCodes.join(','),
    natures: query.natures.join(','),
    keyword: query.keyword.trim() || undefined,
    limit,
    offset,
  };
}
export function buildingLedgerParams(query: BuildingLedgerQuery, offset = 0, limit = 200) {
  return {
    officeCodes: query.officeCodes.join(','),
    keyword: query.keyword.trim() || undefined,
    limit,
    offset,
  };
}

/** 房产汇总 -> CSV。 */
export function propertySummaryCsv(report: PropertySummaryResponse, query: PropertySummaryQuery): string {
  const lines: string[][] = [
    ['统计汇总', '房产汇总'],
    ['管理处', query.officeCodes.join('/') || '全部'],
    [],
    ['管理处', '楼栋数', '房屋数', '业主数', '建筑面积', ...report.natures.map((nature) => `${nature.code} ${nature.name}`)],
  ];
  const part = (row: PropertySummaryCounts) => [
    String(row.buildingCount), String(row.roomCount), String(row.ownerCount), String(row.totalAreaSqm ?? 0),
    ...report.natures.map((nature) => String(row.natureCounts?.[nature.code] ?? 0)),
  ];
  for (const row of report.rows) lines.push([row.officeName || row.officeCode, ...part(row)]);
  if (report.total) lines.push(['合计', ...part(report.total)]);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 住户台账 -> CSV。 */
export function ownerLedgerCsv(report: OwnerLedgerResponse, query: OwnerLedgerQuery): string {
  const lines: string[][] = [
    ['统计汇总', '住户台账'],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['房屋性质', query.natures.join('/') || '全部'],
    ['关键词', query.keyword.trim() || ''],
    [],
    ['序号', '管理处', '地址', '房号', '业主', '手机', '电话', '建筑面积', '房屋性质'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.officeName || row.officeCode, row.address || '', row.roomNo || '', row.ownerName || '',
      row.mobile || '', row.phone2 || '', row.areaSqm === null ? '' : String(row.areaSqm), row.natureName || row.natureCode || '',
    ]);
  });
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 楼房台账 -> CSV。 */
export function buildingLedgerCsv(report: BuildingLedgerResponse, query: BuildingLedgerQuery): string {
  const lines: string[][] = [
    ['统计汇总', '楼房台账'],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['关键词', query.keyword.trim() || ''],
    [],
    ['序号', '管理处', '路', '弄/号', '楼号', '房屋数', '业主数', '建筑面积'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.officeName || row.officeCode, row.road || '', row.lane || '',
      row.buildingNo || '', String(row.roomCount), String(row.ownerCount), String(row.areaSqm ?? 0),
    ]);
  });
  if (report.totals) {
    lines.push(['合计', '', '', '', String(report.totals.buildingCount ?? report.rows.length), String(report.totals.roomCount ?? 0), String(report.totals.ownerCount ?? 0), String(report.totals.areaSqm ?? 0)]);
  }
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

// ───────────────────────── P4-A：减免情况统计 / 签报情况统计 ─────────────────────────

export interface ReliefRow {
  id: number | string;
  docNo: string | null;
  officeCode: string;
  officeName?: string | null;
  zhId?: number | string | null;
  address: string | null;
  ownerName: string | null;
  feeCode?: string | null;
  feeName: string | null;
  oldReceivableCents: number;
  receivableCents: number;
  reliefCents: number;
  reliefStartDate: string | null;
  reliefEndDate: string | null;
  reliefDate: string | null;
  method: string | null;
}
export interface ReliefResponse {
  rows: ReliefRow[];
  totals: { count?: number; oldReceivableCents?: number; receivableCents?: number; reliefCents?: number } | null;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export interface SignoffRow {
  id: number | string;
  docNo: string | null;
  title: string | null;
  type: string | null;
  detail?: string | null;
  officeCode: string;
  officeName?: string | null;
  zhId?: number | string | null;
  address: string | null;
  ownerName: string | null;
  draftDate: string | null;
  approveDate: string | null;
  result: string | null;
  voided: boolean;
  ended: boolean;
  adjustAmountCents: number;
  feeCode?: string | null;
}
export interface SignoffsResponse {
  rows: SignoffRow[];
  totals: { count?: number; voidedCount?: number; endedCount?: number; adjustAmountCents?: number } | null;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export function reliefParams(query: ReliefQuery, offset = 0, limit = 200) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    keyword: query.keyword.trim() || undefined,
    limit,
    offset,
  };
}
export function signoffsParams(query: SignoffsQuery, offset = 0, limit = 200) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    types: query.types.join(','),
    status: query.status,
    keyword: query.keyword.trim() || undefined,
    limit,
    offset,
  };
}

/** 减免情况 -> CSV。 */
export function reliefCsv(report: ReliefResponse, query: ReliefQuery): string {
  const lines: string[][] = [
    ['统计汇总', '减免情况统计'],
    ['减免日期范围', [query.dateFrom, query.dateTo].filter(Boolean).join('~')],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收费项目', query.feeCodes.join('/') || '全部'],
    ['关键词', query.keyword.trim() || ''],
    [],
    ['序号', '文号', '管理处', '地址', '业主', '收费项目', '原应收', '现应收', '减免金额', '减免起', '减免止', '减免日期', '方式'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.docNo || '', row.officeName || row.officeCode, row.address || '', row.ownerName || '',
      row.feeName || row.feeCode || '', centsForCsv(row.oldReceivableCents), centsForCsv(row.receivableCents),
      centsForCsv(row.reliefCents), row.reliefStartDate || '', row.reliefEndDate || '', row.reliefDate || '', row.method || '',
    ]);
  });
  if (report.totals) lines.push(['合计', '', '', '', '', '', centsForCsv(report.totals.oldReceivableCents), centsForCsv(report.totals.receivableCents), centsForCsv(report.totals.reliefCents), '', '', '', '']);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** 签报情况 -> CSV。 */
export function signoffsCsv(report: SignoffsResponse, query: SignoffsQuery): string {
  const lines: string[][] = [
    ['统计汇总', '签报情况统计'],
    ['拟稿日期范围', [query.dateFrom, query.dateTo].filter(Boolean).join('~')],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['状态', query.status],
    ['类型', query.types.join('/') || '全部'],
    ['关键词', query.keyword.trim() || ''],
    [],
    ['序号', '文号', '标题', '类型', '管理处', '地址', '业主', '拟稿日期', '审批日期', '结果', '是否作废', '是否结束', '调整金额'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.docNo || '', row.title || '', row.type || '', row.officeName || row.officeCode,
      row.address || '', row.ownerName || '', row.draftDate || '', row.approveDate || '', row.result || '',
      row.voided ? '是' : '否', row.ended ? '是' : '否', centsForCsv(row.adjustAmountCents),
    ]);
  });
  if (report.totals) lines.push(['合计', '', '', '', '', '', '', '', '', '', '', '', centsForCsv(report.totals.adjustAmountCents)]);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

// ───────────────────────── P2-E：收款汇总表 / 票据情况统计 ─────────────────────────

export interface TicketSummaryMethodColumn { key: string; label: string }
export interface TicketSummaryRow {
  feeCode: string;
  feeName: string;
  methods: Record<string, number>;
  receivedCents: number;
  refundCents: number;
  netCents: number;
  ticketAmountCents: number | null;
  ticketTaxCents: number | null;
  ticketIncomeCents: number | null;
  ticketCount: number | null;
  rows: number;
}
export interface TicketSummaryTotals {
  methods: Record<string, number>;
  receivedCents: number;
  refundCents: number;
  netCents: number;
  ticketAmountCents: number | null;
  ticketTaxCents: number | null;
  ticketIncomeCents: number | null;
  ticketCount: number | null;
  rows: number;
}
export interface TicketSummaryCashierRow {
  cashier: string;
  methods: Record<string, number>;
  netCents: number;
  rows: number;
}
export interface TicketSummaryResponse {
  methodColumns: TicketSummaryMethodColumn[];
  rows: TicketSummaryRow[];
  totals: TicketSummaryTotals | null;
  cashierRows: TicketSummaryCashierRow[];
  cashierTotals: TicketSummaryCashierRow | null;
  /** available 仅表示收款块可用；票据块依赖票据及开票明细两个镜像。 */
  ticketBlockReady?: boolean;
  ticketDataAsOf?: string | null;
  partial?: boolean;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export interface TicketRow {
  id: number | string;
  ticketNo: string | null;
  warehouseNo: string | null;
  officeCode: string;
  officeName?: string | null;
  issueDate: string | null;
  payer: string | null;
  amountCents: number;
  taxCents: number;
  preIssue: boolean;
  receiptDate: string | null;
  issuer: string | null;
  payee: string | null;
  voidDate: string | null;
  voidReason?: string | null;
  writeoffDate: string | null;
  paymentMethod: string | null;
  invoiceNo: string | null;
  status: 'issued' | 'pre_issue' | 'voided' | 'written_off' | string;
}
export interface TicketsResponse {
  rows: TicketRow[];
  totals: { count?: number; amountCents?: number; taxCents?: number; voidedCount?: number; preIssueCount?: number; writtenOffCount?: number } | null;
  statusCounts?: Record<string, number>;
  count?: number | null;
  dataAsOf?: string | null;
  available?: boolean;
  message?: string | null;
}

export function ticketSummaryParams(query: TicketSummaryQuery, offset = 0, limit = 200) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    feeCodes: query.feeCodes.join(','),
    paymentMethods: query.paymentMethods.join(','),
    cashier: query.cashier.trim() || undefined,
    limit,
    offset,
  };
}
export function ticketsParams(query: TicketListQuery, offset = 0, limit = 200) {
  return {
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    officeCodes: query.officeCodes.join(','),
    status: query.status,
    keyword: query.keyword.trim() || undefined,
    limit,
    offset,
  };
}

/** 兼容旧响应时也不把缺失的票据字段当 0；显式未就绪优先于数值。 */
export function ticketSummaryTicketReady(report: TicketSummaryResponse): boolean {
  // 老 API 可能仍返回占位 0 + 未同步告警；未给显式就绪时保守保留未知。
  const legacyWarning = report.ticketBlockReady == null && Boolean(report.message);
  return report.ticketBlockReady !== false && report.partial !== true && !legacyWarning && Boolean(report.totals)
    && [...report.rows, ...(report.totals ? [report.totals] : [])].every(row =>
      [row.ticketAmountCents, row.ticketTaxCents, row.ticketIncomeCents, row.ticketCount]
        .every(value => value != null && Number.isFinite(value)));
}

/** 收款汇总表 -> CSV（收款、独立票据口径、收款人三块）。 */
export function ticketSummaryCsv(report: TicketSummaryResponse, query: TicketSummaryQuery): string {
  const lines: string[][] = [
    ['统计汇总', '收款汇总表'],
    ['收款日期范围', [query.dateFrom, query.dateTo].filter(Boolean).join('~')],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['收款方式', query.paymentMethods.join('/') || '全部'],
    ['收款人', query.cashier || '全部'],
    [],
    ['收费项目', ...report.methodColumns.map((column) => column.label), '合计'],
  ];
  for (const row of report.rows) {
    lines.push([
      row.feeName || row.feeCode,
      ...report.methodColumns.map((column) => centsForCsv(Number(row.methods?.[column.key] ?? 0))),
      centsForCsv(row.netCents),
    ]);
  }
  if (report.totals) {
    lines.push([
      '合计',
      ...report.methodColumns.map((column) => centsForCsv(Number(report.totals?.methods?.[column.key] ?? 0))),
      centsForCsv(report.totals.netCents),
    ]);
  }
  const ticketsReady = ticketSummaryTicketReady(report);
  // 仅限本报表：未知票据留空，真实零仍为可计算的 0.00；不改全局金额格式化。
  const ticketMoney = (value: number | null) => ticketsReady && value != null ? centsForCsv(value) : '';
  const ticketCount = (value: number | null) => ticketsReady && value != null ? String(value) : '';
  lines.push([], ['票据口径', ticketsReady ? '开票数据，与收款金额口径不同' : '未就绪：票据金额/税额/不含税收入/张数未知，留空并非 0'],
    ['票据数据截止', report.ticketDataAsOf || ''],
    ['收费项目', '票据金额', '税额', '不含税收入', '票据张数']);
  for (const row of report.rows) {
    lines.push([row.feeName || row.feeCode, ticketMoney(row.ticketAmountCents), ticketMoney(row.ticketTaxCents),
      ticketMoney(row.ticketIncomeCents), ticketCount(row.ticketCount)]);
  }
  if (report.totals) {
    const totals = report.totals;
    lines.push(['合计', ticketMoney(totals.ticketAmountCents), ticketMoney(totals.ticketTaxCents),
      ticketMoney(totals.ticketIncomeCents), ticketCount(totals.ticketCount)]);
  }
  lines.push([], ['其中：按收款人'], ['收款人', ...report.methodColumns.map(column => column.label), '合计', '笔数']);
  for (const row of report.cashierRows) {
    lines.push([row.cashier, ...report.methodColumns.map(column => centsForCsv(row.methods?.[column.key] ?? 0)),
      centsForCsv(row.netCents), String(row.rows)]);
  }
  if (report.cashierTotals) {
    const totals = report.cashierTotals;
    lines.push(['合计', ...report.methodColumns.map(column => centsForCsv(totals.methods?.[column.key] ?? 0)),
      centsForCsv(totals.netCents), String(totals.rows)]);
  }
  return '\uFEFF' + lines.map((line) => line.map(spreadsheetCsvCell).join(',')).join('\r\n');
}

/** 票据情况统计 -> CSV（16 列）。 */
export function ticketsCsv(report: TicketsResponse, query: TicketListQuery): string {
  const lines: string[][] = [
    ['统计汇总', '票据情况统计'],
    ['开票日期范围', [query.dateFrom, query.dateTo].filter(Boolean).join('~')],
    ['管理处', query.officeCodes.join('/') || '全部'],
    ['状态', query.status],
    ['关键词', query.keyword.trim() || ''],
    [],
    ['序号', '票据编号', '入库单编号', '管理处', '开票日期', '付款人', '金额', '税额', '收款日期', '开票人', '收款人', '作废日期', '核销日期', '收款方式', '发票号', '状态'],
  ];
  report.rows.forEach((row, index) => {
    lines.push([
      String(index + 1), row.ticketNo || '', row.warehouseNo || '', row.officeName || row.officeCode,
      row.issueDate || '', row.payer || '', centsForCsv(row.amountCents), centsForCsv(row.taxCents),
      row.receiptDate || '', row.issuer || '', row.payee || '', row.voidDate || '', row.writeoffDate || '',
      row.paymentMethod || '', row.invoiceNo || '', statusText(row.status),
    ]);
  });
  if (report.totals) {
    lines.push(['合计', '', '', '', '', `件数 ${report.totals.count ?? report.rows.length}`, centsForCsv(report.totals.amountCents), centsForCsv(report.totals.taxCents), '', '', '', '', '', '', '', '']);
  }
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

export function statusText(status: string): string {
  return ({ issued: '已开', pre_issue: '预开', voided: '作废', written_off: '已核销' } as Record<string, string>)[status] || status;
}

/** 年度汇总 -> CSV 文本（带 UTF-8 BOM，Excel 直接打开不乱码）。 */
export function annualCsv(annual: AnnualSummaryResponse, context: CsvContext): string {
  const { filters } = context;
  const officeText = filters.officeCodes.map((code) => {
    const office = context.offices?.find((item) => item.officeCode === code);
    return office?.name || code;
  }).join('/') || '全部';
  const feeText = filters.feeCodes.map((code) => context.feeItems?.find((item) => item.code === code)?.name || code).join('/') || '全部';
  const natureText = filters.natures.map((code) => context.natures?.find((item) => item.code === code)?.name || code).join('/') || '全部';
  const lines: string[][] = [
    ['统计汇总', reportName(annual.type)],
    ['数据截止', String(context.dataAsOf || annual.dataAsOf || '')],
    ['管理处', officeText],
    ['收费项目', feeText],
    ['房屋性质', natureText],
    ['应收截止年月', annual.type === 'arrears' ? (filters.asOfPeriod || '') : '（仅欠费报表使用）'],
    ['收款日期范围', [filters.paidDateFrom, filters.paidDateTo].filter(Boolean).join('~')],
    [],
    ['管理处', ...annual.columns.map(String), '合计'],
  ];
  for (const row of annual.rows) {
    lines.push([row.officeName || row.officeCode, ...annual.columns.map((year) => centsForCsv(cellCents(row, year))), centsForCsv(row.totalCents)]);
  }
  const subtotal = annual.subtotal ?? { cells: {}, totalCents: 0 };
  lines.push(['小计', ...annual.columns.map((year) => centsForCsv(cellCents(subtotal, year))), centsForCsv(subtotal.totalCents)]);
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || '统计汇总';
}

/** 触发浏览器下载；返回是否成功发起。 */
export function downloadCsv(filename: string, csv: string): boolean {
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFilename(filename.endsWith('.csv') ? filename : `${filename}.csv`);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
