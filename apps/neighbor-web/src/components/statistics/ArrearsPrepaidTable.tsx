import { fmtArea, fmtCents, fmtPeriod } from '@/lib/statistics';
import type { ArrearsPrepaidDetailResponse, ArrearsPrepaidQuery } from '@/lib/statistics';

/** 欠收与溢收明细表：行=房屋×收费项目；查看→逐笔；底部合计。 */
export default function ArrearsPrepaidTable({ report, tab, onView }: {
  report: ArrearsPrepaidDetailResponse;
  tab: ArrearsPrepaidQuery['tab'];
  onView: (row: ArrearsPrepaidDetailResponse['rows'][number]) => void;
}) {
  const rangeLabel = tab === 'arrears' ? '欠费年月范围' : '收费年月范围';
  return (
    <div className="t-scroll stats-arrears-table-scroll">
      <table className="t stats-arrears-prepaid-table" data-testid="arrears-prepaid-table">
        <thead>
          <tr>
            <th>序号</th><th>地址</th><th>姓名</th><th className="num">建筑面积</th><th>收费项目</th>
            <th>{rangeLabel}</th><th className="num">月份数</th><th className="num">金额</th><th>说明</th><th>查看</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.sId ?? 'x'}-${row.feeCode}-${index}`} data-s-id={row.sId ?? undefined} data-fee-code={row.feeCode}>
              <td className="muted">{index + 1}</td>
              <td><b>{row.address || '—'}</b></td>
              <td>{row.ownerName || '—'}</td>
              <td className="num">{fmtArea(row.areaSqm)}</td>
              <td>{row.feeName || row.feeCode}</td>
              <td>{[fmtPeriod(row.periodFrom), fmtPeriod(row.periodTo)].filter((text) => text !== '—').join(' ~ ') || '—'}</td>
              <td className="num">{row.months ?? '—'}</td>
              <td className={`num ${row.amountCents === 0 ? 'stats-num-muted' : tab === 'arrears' ? 'stats-num-neg' : 'stats-num-info'}`}>
                <b>{row.amountCents === 0 ? '—' : fmtCents(row.amountCents)}</b>
              </td>
              <td className="muted" title="车位编号/车库说明需补镜像">—</td>
              <td><button type="button" className="btn sm" data-view-bills onClick={() => onView(row)}>查看</button></td>
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="arrears-prepaid-total">
              <td colSpan={6}><b>合计</b></td>
              <td className="num"><b>{report.totals.rows}</b></td>
              <td className="num"><b>{report.totals.amountCents === 0 ? '—' : fmtCents(report.totals.amountCents)}</b></td>
              <td colSpan={2} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
