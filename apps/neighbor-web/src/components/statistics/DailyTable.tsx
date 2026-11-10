import { fmtCents } from '@/lib/statistics';
import type { CollectionDetailKind, DailyResponse } from '@/lib/statistics';

export interface DailyCellTarget {
  date?: string;
  feeCode: string;
  feeName: string;
  kind?: CollectionDetailKind;
}

/** 日期×收费项目正收款；退款、调整另列，避免把收款合计误读成净收款。 */
export default function DailyTable({ report, onCellClick }: {
  report: DailyResponse;
  onCellClick: (target: DailyCellTarget) => void;
}) {
  const subtotal = report.subtotal;
  const amount = (cents: number | null | undefined, target: DailyCellTarget) => cents == null ? '—' : (
    <button type="button" className={`stats-money-btn ${cents === 0 ? 'stats-num-muted' : cents < 0 ? 'stats-num-neg' : ''}`} title="查看对应逐笔明细" data-daily-kind={target.kind || 'received'} onClick={() => onCellClick(target)}>
      {cents === 0 ? '—' : fmtCents(cents)}
    </button>
  );
  return (
    <div className="t-scroll stats-matrix-scroll">
      <table className="t stats-daily-table" data-testid="daily-table">
        <thead>
          <tr>
            <th className="stats-sticky-name">日期</th>
            {report.columns.map((column) => <th key={column.code} className="num">{column.name}</th>)}
            <th className="num stats-p2-total-col">收款合计</th>
            <th className="num">退款</th>
            <th className="num">调整</th>
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
              <td className="num stats-p2-total-col">{amount(row.totalCents, { date: row.date, feeCode: '', feeName: '所选收费项目' })}</td>
              <td className="num">{amount(row.refundCents, { date: row.date, feeCode: '', feeName: '所选收费项目', kind: 'refund' })}</td>
              <td className="num">{amount(row.adjustCents, { date: row.date, feeCode: '', feeName: '所选收费项目', kind: 'adjust' })}</td>
            </tr>
          ))}
          {subtotal ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="daily-subtotal">
              <td className="stats-sticky-name"><b>合计</b></td>
              {report.columns.map((column) => (
                <td key={column.code} className="num">{amount(Number(subtotal.cells?.[column.code] ?? 0), { feeCode: column.code, feeName: column.name })}</td>
              ))}
              <td className="num stats-p2-total-col">{amount(subtotal.totalCents, { feeCode: '', feeName: '所选收费项目' })}</td>
              <td className="num">{amount(report.refundTotalCents, { feeCode: '', feeName: '所选收费项目', kind: 'refund' })}</td>
              <td className="num">{amount(report.adjustTotalCents, { feeCode: '', feeName: '所选收费项目', kind: 'adjust' })}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
