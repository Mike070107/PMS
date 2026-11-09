import { BadRequestException } from '@nestjs/common';
import { STATISTICS_OFFICE_NAMES } from './statistics.util';

/**
 * 收费汇总类报表（P2）的纯函数层：日期校验、分组标签、矩阵拼装。
 *
 * 金额一律整数分；这里只做区间校验/表格拼装，不做元/分换算。
 * 与 P1 的 statistics.util.ts 分开，避免改变 P1 已上线行为。
 */

/** 收费汇总分组维度：收费项目 / 管理处 / 收款方式 / 收款人。 */
export const COLLECTION_GROUP_BYS = ['fee', 'office', 'method', 'cashier'] as const;
export type CollectionGroupBy = (typeof COLLECTION_GROUP_BYS)[number];

/** 收费明细行过滤：全部 / 收款块 / 退款块 / 调整块。 */
export const COLLECTION_DETAIL_KINDS = ['all', 'received', 'refund', 'adjust'] as const;
export type CollectionDetailKind = (typeof COLLECTION_DETAIL_KINDS)[number];

/** 日期区间跨度上限：旧报表按月/年统计，单次最多一年多一点，避免一次拉全库。 */
export const COLLECTION_MAX_RANGE_DAYS = 366;

export const COLLECTION_DEFAULT_DETAIL_LIMIT = 200;
export const COLLECTION_MAX_DETAIL_LIMIT = 500;

/** 月报表年度范围（对齐旧系统镜像 period 覆盖 2004-07 起）。 */
export const COLLECTION_YEAR_MIN = 2004;
export const COLLECTION_YEAR_MAX = 2100;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析 YYYY-MM-DD 为 UTC 毫秒时间戳。
 * 除了格式，还拒绝 2026-02-30 / 2026-13-01 这类日历上不存在的日期（400，不静默纠正）。
 */
export function parseCollectionDate(value: string, field: string): number {
  const match = typeof value === 'string' ? DATE_ONLY_RE.exec(value.trim()) : null;
  if (!match) throw new BadRequestException(`${field} 必须是 YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${field} 不是有效日期`);
  }
  return time;
}

export interface CollectionDateRange {
  dateFrom: string;
  dateTo: string;
}

/**
 * dateFrom/dateTo 必填、from<=to、跨度<=366 天（按自然日差，含首尾）。
 * 越界统一 400，由 Nest ValidationPipe 之外的 service 再兜一层，直接调用 service 也安全。
 */
export function validateCollectionDateRange(dateFrom: string, dateTo: string): CollectionDateRange {
  const from = parseCollectionDate(dateFrom, 'dateFrom');
  const to = parseCollectionDate(dateTo, 'dateTo');
  if (from > to) throw new BadRequestException('dateFrom 不能晚于 dateTo');
  if ((to - from) / 86_400_000 > COLLECTION_MAX_RANGE_DAYS) {
    throw new BadRequestException(`日期跨度不能超过 ${COLLECTION_MAX_RANGE_DAYS} 天`);
  }
  return { dateFrom: dateFrom.trim(), dateTo: dateTo.trim() };
}

/** 日期区间统一左闭右开 [dateFrom, dateTo+1)：返回 dateTo 的次日 YYYY-MM-DD。 */
export function nextCollectionDate(dateTo: string): string {
  const time = parseCollectionDate(dateTo, 'dateTo');
  const next = new Date(time + 86_400_000);
  const year = next.getUTCFullYear();
  const month = String(next.getUTCMonth() + 1).padStart(2, '0');
  const day = String(next.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 月报表年度：2004–2100 的整数；直接调用 service 时同样 400。 */
export function validateCollectionYear(year: number): number {
  if (!Number.isInteger(year) || year < COLLECTION_YEAR_MIN || year > COLLECTION_YEAR_MAX) {
    throw new BadRequestException(`year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间`);
  }
  return year;
}

/**
 * 分组行 label：
 * - 管理处用旧系统名称常量（STATISTICS_OFFICE_NAMES），不读 MIS 表；
 * - 收费项目优先用镜像字典/账单里的名称，缺失时回退代码，不伪造名称；
 * - 收款方式/收款人空值统一「未记录」，不把空串当成人名/方式。
 */
export function collectionGroupLabel(
  groupBy: CollectionGroupBy,
  key: string,
  feeLabel?: string | null,
): string {
  if (groupBy === 'office') return STATISTICS_OFFICE_NAMES[key] ?? `管理处${key}`;
  if (groupBy === 'fee') {
    const label = feeLabel?.trim();
    if (label) return label;
    return key ? `收费项目${key}` : '未分类';
  }
  return key ? key : '未记录';
}

export interface CollectionFeeColumn {
  code: string;
  name: string;
}

export interface CollectionReportCells {
  [code: string]: number;
}

export interface CollectionBlockTotals {
  receivedCents: number;
  refundCents: number;
  adjustCents: number;
  netCents: number;
}

export interface CollectionSummaryRow extends CollectionBlockTotals {
  key: string;
  label: string;
  countReceived: number;
  countRefund: number;
  countAdjust: number;
  count: number;
}

export interface CollectionDailyRow {
  date: string;
  cells: CollectionReportCells;
  receivedCents: number;
  refundCents: number;
  adjustCents: number;
  totalCents: number;
}

export interface CollectionMonthlyRow {
  month: number;
  cells: CollectionReportCells;
  totalCents: number;
}

export interface CollectionReportSubtotal {
  cells: CollectionReportCells;
  totalCents: number;
}

export interface CollectionDailyRawRow {
  date: string;
  feeCode: string | null;
  receivedCents: number | string;
  refundCents: number | string;
  adjustCents: number | string;
}

export interface CollectionMonthlyRawRow {
  month: number | string;
  feeCode: string | null;
  amountCents: number | string;
}

export interface CollectionFeeNatureRawRow {
  feeCode: string | null;
  natureCode: string | null;
  receivedCents: number | string;
  refundCents: number | string;
  adjustCents: number | string;
}

export interface CollectionFeeNatureRow extends CollectionBlockTotals {
  feeCode: string;
  feeName: string;
  cells: CollectionReportCells;
}

export interface CollectionFeeNatureReport {
  columns: CollectionFeeColumn[];
  rows: CollectionFeeNatureRow[];
  subtotal: CollectionBlockTotals & { cells: CollectionReportCells };
}

function feeCodeOf(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * 列 = 字典列 + 聚合结果里出现但字典没有的收费项目（回退名称=代码）。
 * 这样单元格合计能覆盖全部命中行，不会因为未知 fee_code 让合计对不上下钻。
 * 空 fee_code 作为「未分类」列追加在最后。
 */
function withObservedFeeColumns(
  columns: CollectionFeeColumn[],
  observed: Array<string | null | undefined>,
): CollectionFeeColumn[] {
  const known = new Set(columns.map((column) => column.code));
  const extras: string[] = [];
  let hasBlank = false;
  for (const value of observed) {
    const code = feeCodeOf(value);
    if (!code) {
      hasBlank = true;
      continue;
    }
    if (known.has(code) || extras.includes(code)) continue;
    extras.push(code);
  }
  extras.sort();
  const merged = [...columns, ...extras.map((code) => ({ code, name: code }))];
  if (hasBlank && !merged.some((column) => column.code === '')) {
    merged.push({ code: '', name: '未分类' });
  }
  return merged;
}

function emptyCells(columns: CollectionFeeColumn[]): CollectionReportCells {
  const cells: CollectionReportCells = {};
  for (const column of columns) cells[column.code] = 0;
  return cells;
}

function subtotalOf(
  columns: CollectionFeeColumn[],
  rows: Array<{ cells: CollectionReportCells }>,
): CollectionReportSubtotal {
  const cells: CollectionReportCells = {};
  let totalCents = 0;
  for (const column of columns) {
    const cents = rows.reduce((sum, row) => sum + (row.cells[column.code] ?? 0), 0);
    cells[column.code] = cents;
    totalCents += cents;
  }
  return { cells, totalCents };
}

/**
 * 收费汇总「收费项目 × 房屋性质」矩阵：
 * 行 = 收费项目（字典顺序 + 数据里出现但字典缺的 code），列 = FWXZK 房屋性质；
 * cell = 该收费项目×性质的净额（收款块 + 调整块；退款块单列，不重复扣减）；
 * 行/总计的四个金额块包含 nature 为空的行（空值不算任何性质，不落入任何列）。
 */
export function buildCollectionFeeNatureReport(
  columns: CollectionFeeColumn[],
  natures: Array<{ code: string; name: string }>,
  raw: CollectionFeeNatureRawRow[],
): CollectionFeeNatureReport {
  const finalColumns = withObservedFeeColumns(columns, raw.map((row) => row.feeCode));
  const natureCodes = new Set(natures.map((nature) => nature.code));
  const buckets = new Map<string, { receivedCents: number; refundCents: number; adjustCents: number }>();
  const bucketKey = (feeCode: string, natureCode: string) => `${feeCode}\u0000${natureCode}`;
  for (const row of raw) {
    const feeCode = feeCodeOf(row.feeCode);
    const natureCode = (row.natureCode ?? '').trim();
    const key = bucketKey(feeCode, natureCode);
    const bucket = buckets.get(key) ?? { receivedCents: 0, refundCents: 0, adjustCents: 0 };
    bucket.receivedCents += Number(row.receivedCents || 0);
    bucket.refundCents += Number(row.refundCents || 0);
    bucket.adjustCents += Number(row.adjustCents || 0);
    buckets.set(key, bucket);
  }
  const rows: CollectionFeeNatureRow[] = finalColumns.map((column) => {
    const cells: CollectionReportCells = {};
    for (const nature of natures) cells[nature.code] = 0;
    let receivedCents = 0;
    let refundCents = 0;
    let adjustCents = 0;
    for (const [key, bucket] of buckets) {
      const separator = key.indexOf('\u0000');
      const feeCode = key.slice(0, separator);
      const natureCode = key.slice(separator + 1);
      if (feeCode !== column.code) continue;
      receivedCents += bucket.receivedCents;
      refundCents += bucket.refundCents;
      adjustCents += bucket.adjustCents;
      if (natureCodes.has(natureCode)) {
        // 净额口径 = 该期间有效净收款（收款块+调整块）；退款块单列，不重复扣减。
        cells[natureCode] += bucket.receivedCents + bucket.adjustCents;
      }
    }
    return {
      feeCode: column.code,
      feeName: column.name,
      cells,
      receivedCents,
      refundCents,
      adjustCents,
      netCents: receivedCents + adjustCents,
    };
  });
  const cells: CollectionReportCells = {};
  for (const nature of natures) {
    cells[nature.code] = rows.reduce((sum, row) => sum + (row.cells[nature.code] ?? 0), 0);
  }
  return {
    columns: finalColumns,
    rows,
    subtotal: {
      cells,
      receivedCents: rows.reduce((sum, row) => sum + row.receivedCents, 0),
      refundCents: rows.reduce((sum, row) => sum + row.refundCents, 0),
      adjustCents: rows.reduce((sum, row) => sum + row.adjustCents, 0),
      netCents: rows.reduce((sum, row) => sum + row.netCents, 0),
    },
  };
}

/**
 * 日常收费项目收款日报表矩阵（P2-B 修正口径）：
 * cells = 收款块（paid_date ∈ 区间 & refund_date IS NULL & amount>0），行=收款日期升序；
 * 退款块按退款日期、调整块按收款日期在行上单列；只返回有收款发生的日期。
 */
export function buildCollectionDailyReport(
  columns: CollectionFeeColumn[],
  raw: CollectionDailyRawRow[],
): {
  columns: CollectionFeeColumn[];
  rows: CollectionDailyRow[];
  subtotal: CollectionReportSubtotal;
  refundTotalCents: number;
  adjustTotalCents: number;
} {
  const finalColumns = withObservedFeeColumns(columns, raw.map((row) => row.feeCode));
  const byDate = new Map<string, { cells: Map<string, number>; refundCents: number; adjustCents: number }>();
  let refundTotalCents = 0;
  let adjustTotalCents = 0;
  for (const row of raw) {
    const date = String(row.date ?? '').trim();
    if (!date) continue;
    const refundCents = Number(row.refundCents || 0);
    const adjustCents = Number(row.adjustCents || 0);
    refundTotalCents += refundCents;
    adjustTotalCents += adjustCents;
    let entry = byDate.get(date);
    if (!entry) {
      entry = { cells: new Map<string, number>(), refundCents: 0, adjustCents: 0 };
      byDate.set(date, entry);
    }
    const code = feeCodeOf(row.feeCode);
    entry.cells.set(code, (entry.cells.get(code) ?? 0) + Number(row.receivedCents || 0));
    entry.refundCents += refundCents;
    entry.adjustCents += adjustCents;
  }
  const rows: CollectionDailyRow[] = [...byDate.entries()]
    .filter(([, entry]) => [...entry.cells.values()].some((cents) => cents !== 0))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, entry]) => {
      const cells = emptyCells(finalColumns);
      for (const column of finalColumns) cells[column.code] = entry.cells.get(column.code) ?? 0;
      const receivedCents = finalColumns.reduce((sum, column) => sum + cells[column.code], 0);
      return {
        date,
        cells,
        receivedCents,
        refundCents: entry.refundCents,
        adjustCents: entry.adjustCents,
        totalCents: receivedCents,
      };
    });
  return {
    columns: finalColumns,
    rows,
    subtotal: subtotalOf(finalColumns, rows),
    refundTotalCents,
    adjustTotalCents,
  };
}

/**
 * 月报表矩阵：固定 12 行（1–12 月，无数据月份补 0），列 = 收费项目；合计 = 全年净额。
 * 月份按报表事件日期（收款日/退款日）归属，与 daily、collection/detail 保持同一净额口径。
 */
export function buildCollectionMonthlyReport(
  columns: CollectionFeeColumn[],
  raw: CollectionMonthlyRawRow[],
): { columns: CollectionFeeColumn[]; rows: CollectionMonthlyRow[]; subtotal: CollectionReportSubtotal } {
  const finalColumns = withObservedFeeColumns(columns, raw.map((row) => row.feeCode));
  const byMonth = new Map<number, Map<string, number>>();
  for (const row of raw) {
    const month = Number(row.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    const code = feeCodeOf(row.feeCode);
    let cells = byMonth.get(month);
    if (!cells) {
      cells = new Map<string, number>();
      byMonth.set(month, cells);
    }
    cells.set(code, (cells.get(code) ?? 0) + Number(row.amountCents || 0));
  }
  const rows: CollectionMonthlyRow[] = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const aggregated = byMonth.get(month);
    const cells = emptyCells(finalColumns);
    for (const column of finalColumns) cells[column.code] = aggregated?.get(column.code) ?? 0;
    const totalCents = finalColumns.reduce((sum, column) => sum + cells[column.code], 0);
    return { month, cells, totalCents };
  });
  return { columns: finalColumns, rows, subtotal: subtotalOf(finalColumns, rows) };
}
