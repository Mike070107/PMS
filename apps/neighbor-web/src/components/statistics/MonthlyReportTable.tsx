import { fmtCents } from '@/lib/statistics';
import type { MonthlyReportResponse, MonthlyReportTotals } from '@/lib/statistics';

const COLUMNS: Array<{ key: keyof MonthlyReportTotals; label: string; percent?: boolean }> = [
  { key: 'monthReceivableCents', label: '月应收' },
  { key: 'monthAdjustCents', label: '月调整' },
  { key: 'cumulativeReceivableCents', label: '累计应收' },
  { key: 'oldArrearsReceivableCents', label: '旧欠应收' },
  { key: 'totalReceivableCents', label: '合计应收' },
  { key: 'monthReceivedCents', label: '本期实收' },
  { key: 'prepaidInCents', label: '预收转入' },
  { key: 'prepaidBalanceCents', label: '预收余额' },
  { key: 'monthArrearsCents', label: '当月欠收' },
  { key: 'cumulativeArrearsCents', label: '累计欠收' },
  { key: 'recoveryRatePct', label: '本期回收率', percent: true },
];

function cell(value: number | undefined, percent?: boolean): string {
  if (percent) return `${(Number(value) || 0).toFixed(2)}%`;
  if (!value) return '—';
  return fmtCents(value);
}
function amountClass(value: number | undefined, percent?: boolean): string {
  if (percent) return '';
  if (!value) return 'stats-num-muted';
  return Number(value) < 0 ? 'stats-num-neg' : '';
}

/** 收费月报表（核心指标）：行=管理处，11 项核心指标 + 合计行。 */
export default function MonthlyReportTable({ report }: { report: MonthlyReportResponse }) {
  return (
    <div className="t-scroll stats-monthly-report-scroll">
      <table className="t stats-monthly-report-table" data-testid="monthly-report-table">
        <thead>
          <tr>
            <th className="stats-sticky-name">管理处</th>
            {COLUMNS.map((column) => <th key={column.key} className="num">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.key} data-monthly-key={row.key}>
              <td className="stats-sticky-name"><b>{row.label || row.key}</b></td>
              {COLUMNS.map((column) => (
                <td key={column.key} className={`num ${amountClass(row[column.key] as number | undefined, column.percent)}`}>{cell(row[column.key] as number | undefined, column.percent)}</td>
              ))}
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="monthly-report-total">
              <td className="stats-sticky-name"><b>合计</b></td>
              {COLUMNS.map((column) => (
                <td key={column.key} className={`num ${amountClass(report.totals?.[column.key] as number | undefined, column.percent)}`}><b>{cell(report.totals?.[column.key] as number | undefined, column.percent)}</b></td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
