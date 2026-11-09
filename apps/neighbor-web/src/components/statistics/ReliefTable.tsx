import { fmtCents } from '@/lib/statistics';
import type { ReliefResponse } from '@/lib/statistics';

/** 减免情况统计：13 列 + 原应收/现应收/减免金额合计。 */
export default function ReliefTable({ report }: { report: ReliefResponse }) {
  return (
    <div className="t-scroll stats-relief-scroll">
      <table className="t stats-relief-table" data-testid="relief-table">
        <thead>
          <tr>
            <th>序号</th><th>文号</th><th>管理处</th><th>地址</th><th>业主</th><th>收费项目</th>
            <th className="num">原应收</th><th className="num">现应收</th><th className="num">减免金额</th>
            <th>减免起</th><th>减免止</th><th>减免日期</th><th>方式</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.id}-${index}`} data-relief-id={row.id}>
              <td className="muted">{index + 1}</td>
              <td>{row.docNo || '—'}</td>
              <td>{row.officeName || row.officeCode}</td>
              <td><b>{row.address || '—'}</b></td>
              <td>{row.ownerName || '—'}</td>
              <td>{row.feeName || row.feeCode || '—'}</td>
              <td className="num">{fmtCents(row.oldReceivableCents)}</td>
              <td className="num">{fmtCents(row.receivableCents)}</td>
              <td className="num"><b>{fmtCents(row.reliefCents)}</b></td>
              <td>{row.reliefStartDate || '—'}</td>
              <td>{row.reliefEndDate || '—'}</td>
              <td>{row.reliefDate || '—'}</td>
              <td>{row.method || '—'}</td>
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row" data-testid="relief-total">
              <td colSpan={6}><b>合计</b></td>
              <td className="num"><b>{fmtCents(report.totals.oldReceivableCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.receivableCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.reliefCents)}</b></td>
              <td colSpan={4} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
