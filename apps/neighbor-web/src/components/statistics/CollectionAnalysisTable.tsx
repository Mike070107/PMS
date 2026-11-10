import { fmtArea, fmtCents } from '@/lib/statistics';
import type { CollectionAnalysisResponse } from '@/lib/statistics';

/** 收款分析（按户）：一行一户；点行看该户逐笔；底部合计。 */
export default function CollectionAnalysisTable({ report, onRowClick }: {
  report: CollectionAnalysisResponse;
  onRowClick: (row: CollectionAnalysisResponse['rows'][number]) => void;
}) {
  return (
    <div className="t-scroll stats-analysis-scroll">
      <table className="t stats-analysis-table" data-testid="collection-analysis-table">
        <thead>
          <tr>
            <th>序号</th><th>地址</th><th>业主</th><th className="num">建筑面积</th>
            <th className="num">历年欠收</th><th className="num">当年欠收</th><th className="num">当月应收</th>
            <th className="num">预缴</th><th className="num">区间实收</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.sId ?? 'x'}-${index}`} data-s-id={row.sId ?? undefined} className="stats-click-row" onClick={() => onRowClick(row)}>
              <td className="muted">{index + 1}</td>
              <td><b>{row.address || '—'}</b></td>
              <td>{row.ownerName || '—'}</td>
              <td className="num">{fmtArea(row.areaSqm)}</td>
              <td className="num">{fmtCents(row.historyArrearsCents)}</td>
              <td className="num"><b>{fmtCents(row.currentYearArrearsCents)}</b></td>
              <td className="num">{fmtCents(row.currentMonthReceivableCents)}</td>
              <td className="num">{fmtCents(row.prepaidCents)}</td>
              <td className="num">{fmtCents(row.periodReceivedCents)}</td>
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="collection-analysis-total">
              <td colSpan={4}><b>合计</b></td>
              <td className="num"><b>{fmtCents(report.totals.historyArrearsCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.currentYearArrearsCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.currentMonthReceivableCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.prepaidCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.periodReceivedCents)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
