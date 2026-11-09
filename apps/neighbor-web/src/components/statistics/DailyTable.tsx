import { fmtCents } from '@/lib/statistics';
import type { DailyResponse } from '@/lib/statistics';

export interface DailyCellTarget {
  date: string;
  feeCode: string;
  feeName: string;
}

/** 收款日报表：行=日期、列=收费项目当日收款；右侧合计列、底部合计行；点单元格下钻当日收款明细。 */
export default function DailyTable({ report, onCellClick }: {
  report: DailyResponse;
  onCellClick: (target: DailyCellTarget) => void;
}) {
  const subtotal = report.subtotal;
  const amount = (cents: number, target: DailyCellTarget) => (
    <button type="button" className="stats-money-btn" title="查看当日收款明细" onClick={() => onCellClick(target)}>
      {fmtCents(cents)}
    </button>
  );
  return (
    <div className="t-scroll stats-matrix-scroll">
      <table className="t stats-daily-table" data-testid="daily-table">
        <thead>
          <tr>
            <th className="stats-sticky-name">日期</th>
            {report.columns.map((column) => <th key={column.code} className="num">{column.name}</th>)}
            <th className="num stats-p2-total-col">合计</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.date} data-daily-date={row.date}>
              <td className="stats-sticky-name"><b>{row.date}</b></td>
              {report.columns.map((column) => (
                <td key={column.code} className="num">
                  {amount(Number(row.cells?.[column.code] ?? 0), { date: row.date, feeCode: column.code, feeName: column.name })}
                </td>
              ))}
              <td className="num stats-p2-total-col"><b>{fmtCents(row.totalCents)}</b></td>
            </tr>
          ))}
          {subtotal ? (
            <tr className="stats-subtotal-row" data-testid="daily-subtotal">
              <td className="stats-sticky-name"><b>合计</b></td>
              {report.columns.map((column) => (
                <td key={column.code} className="num"><b>{fmtCents(Number(subtotal.cells?.[column.code] ?? 0))}</b></td>
              ))}
              <td className="num stats-p2-total-col"><b>{fmtCents(subtotal.totalCents)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
