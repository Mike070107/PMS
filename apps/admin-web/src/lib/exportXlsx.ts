/**
 * 报表导出 Excel（.xlsx）。SheetJS 按需加载（import()），不进首屏包。
 *
 * 用法：
 *   await exportXlsx('工单统计_2026-08', [
 *     { name: '汇总', columns: [{ title: '指标', key: 'k' }, { title: '值', key: 'v' }], rows: [...] },
 *     { name: '明细', columns, rows },
 *   ]);
 * columns 里的 key 取 row 上的字段；给 render 时用 render(row) 的返回值（导出用纯文本 / 数字，
 * 别把 React 节点塞进来）。金额一律导出成「元」的数字，Excel 里能直接求和。
 */
export interface ExportColumn<T> {
  title: string;
  key: keyof T | string;
  render?: (row: T) => string | number | null | undefined;
  /** 列宽（字符数），不填按标题和内容估一个 */
  width?: number;
}

export interface ExportSheet<T = Record<string, unknown>> {
  name: string;
  columns: ExportColumn<T>[];
  rows: T[];
}

function cellValue<T>(col: ExportColumn<T>, row: T): string | number | null {
  const value = col.render ? col.render(row) : (row as Record<string, unknown>)[col.key as string];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

/** Excel 工作表名不能含 : \ / ? * [ ]，且 ≤ 31 字符 */
function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet';
}

function textWidth(value: string | number | null): number {
  if (value === null) return 0;
  const s = String(value);
  // 中文按 2 个字符宽估
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return w;
}

// 各工作表的行类型可以不同（明细 + 汇总），所以这里放开成 any，类型约束由调用方的 satisfies 承担
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function exportXlsx(fileName: string, sheets: Array<ExportSheet<any>>): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const sheet of sheets) {
    const header = sheet.columns.map((c) => c.title);
    const data = sheet.rows.map((row) => sheet.columns.map((c) => cellValue(c, row)));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws['!cols'] = sheet.columns.map((c, i) => {
      if (c.width) return { wch: c.width };
      const longest = Math.max(
        textWidth(c.title),
        ...data.slice(0, 200).map((r) => textWidth(r[i])),
      );
      return { wch: Math.min(Math.max(longest + 2, 8), 40) };
    });
    let name = safeSheetName(sheet.name);
    let n = 2;
    while (used.has(name)) name = safeSheetName(`${sheet.name}${n++}`);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, `${fileName.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`);
}

/** 分 → 元（数字），导出用；显示用 formatFeeMoney */
export function centsToYuan(cents?: number | null): number {
  return Math.round(cents || 0) / 100;
}
