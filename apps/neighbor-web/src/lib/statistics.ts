/**
 * 统计汇总（旧「一通软件」统计菜单）前端共用类型与纯函数。
 * 金额一律是整数分；页面显示统一 ¥x,xxx.xx，CSV 用纯数字便于 Excel 计算。
 */

export type StatisticsReportType = 'received' | 'arrears' | 'fee-nature' | 'daily';
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
  type: 'daily';
  officeCodes: string[];
  feeCodes: string[];
  natures: string[];
  dateFrom: string;
  dateTo: string;
}

export type ReportQuery = AnnualQuery | CollectionQuery | DailyQuery;

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
}

export const REPORTS: Array<{ type: StatisticsReportType; name: string; hint: string }> = [
  { type: 'received', name: '项目实收年度汇总', hint: '按收款日期年度汇总实收金额（含退款红冲负数）' },
  { type: 'arrears', name: '项目欠费年度汇总', hint: '按所属年度汇总未缴金额（收款日期为空）' },
  { type: 'fee-nature', name: '收费汇总', hint: '按收款日期统计收款/退款/调整；行=收费项目、列=房屋性质；点单元格查逐笔明细' },
  { type: 'daily', name: '收款日报表', hint: '按收款日期逐日统计各收费项目收款；点单元格查当日收款明细' },
];

/** 旧系统里尚未接入的报表：只列灰字，不做假按钮，不伪造数据。 */
export const PENDING_REPORTS = [
  '收款汇总表',
  '月报表',
  '综合月报表 B/C',
  '分等综合月报表',
  '收款分析',
  '日常收费项目收款日报表',
  '欠收与溢收汇总',
  '收缴考核',
  '房产汇总',
  '住户台账',
  '楼房台账',
  '空房情况统计',
  '开票数据统计',
  '住户票据查询',
  '票据使用数量统计',
  '签报情况统计',
  '减免情况统计',
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
export interface DailyRow { date: string; cells: AnnualCells; totalCents: number }
export interface DailyResponse {
  columns: P2Column[];
  rows: DailyRow[];
  subtotal: { cells: AnnualCells; totalCents: number } | null;
  refundTotalCents?: number;
  adjustTotalCents?: number;
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
  /** 与单元格一致：后端必须按同一筛选条件返回总额。 */
  totalCents: number | null;
  count?: number | null;
  available?: boolean;
  message?: string | null;
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
    ['统计汇总', '收款日报表'],
    ['数据截止', String(report.dataAsOf || '')],
    ['管理处', filters.officeCodes.join('/') || '全部'],
    ['收费项目', filters.feeCodes.map((code) => feeItems?.find((item) => item.code === code)?.name || code).join('/') || '全部'],
    ['日期范围', [filters.dateFrom, filters.dateTo].filter(Boolean).join('~')],
    [],
    ['日期', ...report.columns.map((column) => column.name), '合计'],
  ];
  for (const row of report.rows) {
    lines.push([row.date, ...report.columns.map((column) => centsForCsv(Number(row.cells?.[column.code] ?? 0))), centsForCsv(row.totalCents)]);
  }
  if (report.subtotal) {
    lines.push(['合计', ...report.columns.map((column) => centsForCsv(Number(report.subtotal?.cells?.[column.code] ?? 0))), centsForCsv(report.subtotal.totalCents)]);
  }
  return '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
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
