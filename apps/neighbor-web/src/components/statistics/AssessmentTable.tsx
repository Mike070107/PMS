import { fmtArea, fmtCents } from '@/lib/statistics';
import type { AssessmentMonth, AssessmentResponse } from '@/lib/statistics';

function monthValue(months: AssessmentMonth[], month: number, key: 'receivableCents' | 'receivedCents'): number {
  return Number(months.find((item) => String(item.month) === String(month))?.[key] ?? 0);
}
function fmtRate(value: number | null | undefined): string {
  return `${(Number(value) || 0).toFixed(2)}%`;
}

/** 收缴考核：行=房屋，列=1–12 月应收/收款 + 合计 + 收缴率；首列/表头 sticky。 */
export default function AssessmentTable({ report }: { report: AssessmentResponse }) {
  return (
    <div className="t-scroll stats-assessment-scroll">
      <table className="t stats-assessment-table" data-testid="assessment-table">
        <thead>
          <tr>
            <th className="stats-sticky-name" rowSpan={2}>地址</th>
            <th className="stats-sticky-owner" rowSpan={2}>住户</th>
            <th className="num" rowSpan={2}>建筑面积</th>
            {Array.from({ length: 12 }, (_, index) => (
              <th key={index} colSpan={2} className="stats-month-head">{index + 1} 月</th>
            ))}
            <th className="num stats-p2-total-col" rowSpan={2}>合计应收</th>
            <th className="num stats-p2-total-col" rowSpan={2}>合计已收</th>
            <th className="num stats-p2-net-col" rowSpan={2}>收缴率</th>
          </tr>
          <tr>
            {Array.from({ length: 12 }, (_, index) => (
              <th key={`recv-${index}`} className="num stats-month-sub">应收</th>
            )).flatMap((header, index) => [
              header,
              <th key={`paid-${index}`} className="num stats-month-sub">收款</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.sId ?? 'x'}-${row.officeCode}-${index}`} data-s-id={row.sId ?? undefined}>
              <td className="stats-sticky-name"><b>{row.address || '—'}</b></td>
              <td className="stats-sticky-owner">{row.ownerName || '—'}</td>
              <td className="num">{fmtArea(row.areaSqm)}</td>
              {Array.from({ length: 12 }, (_, monthIndex) => [
                <td key={`r-${monthIndex}`} className="num">{fmtCents(monthValue(row.months, monthIndex + 1, 'receivableCents'))}</td>,
                <td key={`p-${monthIndex}`} className="num">{fmtCents(monthValue(row.months, monthIndex + 1, 'receivedCents'))}</td>,
              ])}
              <td className="num stats-p2-total-col"><b>{fmtCents(row.totalReceivableCents)}</b></td>
              <td className="num stats-p2-total-col"><b>{fmtCents(row.totalReceivedCents)}</b></td>
              <td className="num stats-p2-net-col"><b>{fmtRate(row.ratePct)}</b></td>
            </tr>
          ))}
          {report.summary ? (
            <tr className="stats-subtotal-row" data-testid="assessment-total">
              <td className="stats-sticky-name" colSpan={3}><b>合计</b></td>
              {Array.from({ length: 12 }, (_, monthIndex) => {
                const receivable = report.rows.reduce((sum, row) => sum + monthValue(row.months, monthIndex + 1, 'receivableCents'), 0);
                const received = report.rows.reduce((sum, row) => sum + monthValue(row.months, monthIndex + 1, 'receivedCents'), 0);
                return [
                  <td key={`tr-${monthIndex}`} className="num"><b>{fmtCents(receivable)}</b></td>,
                  <td key={`tp-${monthIndex}`} className="num"><b>{fmtCents(received)}</b></td>,
                ];
              })}
              <td className="num stats-p2-total-col"><b>{fmtCents(report.summary.receivableCents)}</b></td>
              <td className="num stats-p2-total-col"><b>{fmtCents(report.summary.receivedCents)}</b></td>
              <td className="num stats-p2-net-col"><b>{fmtRate(report.summary.ratePct)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
