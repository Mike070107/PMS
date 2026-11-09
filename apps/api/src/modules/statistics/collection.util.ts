import { BadRequestException } from '@nestjs/common';
import { STATISTICS_OFFICE_NAMES } from './statistics.util';

/**
 * 收费汇总类报表（P2-A）的纯函数层：日期校验、分组标签、日报/月报矩阵拼装。
 *
 * 金额一律整数分；这里只做区间校验/表格拼装，不做元/分换算。
 * 与 P1 的 statistics.util.ts 分开，避免改变 P1 已上线行为。
 */

/** 收费汇总分组维度：收费项目 / 管理处 / 收款方式 / 收款人。 */
export const COLLECTION_GROUP_BYS = ['fee', 'office', 'method', 'cashier'] as const;
export type CollectionGroupBy = (typeof COLLECTION_GROUP_BYS)[number];

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
 * - 收款方式/收款人空值统一「未填写」，不把空串当成人名/方式。
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
  return key ? key : '未填写';
}

export interface CollectionFeeColumn {
  code: string;
  name: string;
}

export interface CollectionReportCells {
  [feeCode: string]: number;
}

export interface CollectionDailyRow {
  date: string;
  cells: CollectionReportCells;
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
  amountCents: number | string;
}

export interface CollectionMonthlyRawRow {
  month: number | string;
  feeCode: string | null;
  amountCents: number | string;
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

/**
 * 日常收费项目收款日报表矩阵：
 * 行 = 有收款/退款发生的日期（升序），列 = 收费项目；没发生的日期不虚构行，缺的收费项目补 0。
 * 退款行金额按净额（-|amount|）计入，与 collection/detail 的 totalCents 同口径。
 */
export function buildCollectionDailyReport(
  columns: CollectionFeeColumn[],
  raw: CollectionDailyRawRow[],
): { columns: CollectionFeeColumn[]; rows: CollectionDailyRow[]; subtotal: CollectionReportSubtotal } {
  const finalColumns = withObservedFeeColumns(columns, raw.map((row) => row.feeCode));
  const byDate = new Map<string, Map<string, number>>();
  for (const row of raw) {
    const date = String(row.date ?? '').trim();
    if (!date) continue;
    const code = feeCodeOf(row.feeCode);
    let cells = byDate.get(date);
    if (!cells) {
      cells = new Map<string, number>();
      byDate.set(date, cells);
    }
    cells.set(code, (cells.get(code) ?? 0) + Number(row.amountCents || 0));
  }
  const rows: CollectionDailyRow[] = [...byDate.keys()]
    .sort()
    .map((date) => {
      const aggregated = byDate.get(date)!;
      const cells = emptyCells(finalColumns);
      for (const column of finalColumns) cells[column.code] = aggregated.get(column.code) ?? 0;
      const totalCents = finalColumns.reduce((sum, column) => sum + cells[column.code], 0);
      return { date, cells, totalCents };
    });
  return { columns: finalColumns, rows, subtotal: subtotalOf(finalColumns, rows) };
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
