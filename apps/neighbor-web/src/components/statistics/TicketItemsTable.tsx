import { fmtCents, ticketItemsCoverageText, type TicketItemsSummaryResponse } from '@/lib/statistics';

const METRICS = ['amountCents', 'taxCents', 'incomeCents'] as const;
export default function TicketItemsTable({ report, onDrill }: {
  report: TicketItemsSummaryResponse;
  onDrill: (key: string | null, label: string) => void;
}) {
  if (!report.available) return <div className="note2" role="status">{report.message || '开票明细镜像尚未同步，不能视为 0。'}</div>;
  const label = { fee: '收费项目', office: '管理处', day: '开票日期' }[report.groupBy];
  return <>
    <div className="note2 stats-ticket-note">按开票日期统计源全部开票行（含作废、预开、核销），非有效净开票或收款；收入＝金额－税额。各组票据张数可能重叠，合计独立去重。点击金额查看逐笔。</div>
    <p className="muted stats-ticket-note" data-testid="ticket-items-coverage">{ticketItemsCoverageText(report.coverage)}</p>
    {!report.rows.length ? <div className="empty">当前筛选没有开票行，可清空日期查看全部历史。</div> : null}
    <div className="t-scroll">
      <table className="t stats-ticket-items-table" data-testid="ticket-items-table">
        <thead><tr><th>{label}</th><th className="num">票据张数</th><th className="num">开票行数</th><th className="num">金额</th><th className="num">税额</th><th className="num">收入（金额－税额）</th></tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.key} data-group-key={row.key}>
          <td>{row.label}</td><td className="num">{row.ticketCount}</td><td className="num">{row.itemCount}</td>
          {METRICS.map(metric => <td className="num" key={metric}>{row.key ? <button type="button" className="stats-money-btn stats-cell-link" aria-label={`${row.label} ${metric === 'amountCents' ? '金额' : metric === 'taxCents' ? '税额' : '收入'}明细`} onClick={() => onDrill(row.key, row.label)}>{fmtCents(row[metric])}</button> : <span title="源分组值缺失，请从合计查看全部明细">{fmtCents(row[metric])}</span>}</td>)}
        </tr>)}
        {report.totals ? <tr className="stats-subtotal-row stats-total-row" data-testid="ticket-items-total"><td><b>独立去重合计</b></td><td className="num">{report.totals.ticketCount}</td><td className="num">{report.totals.itemCount}</td>{METRICS.map(metric => <td className="num" key={metric}><button type="button" className="stats-money-btn stats-cell-link" onClick={() => onDrill(null, '全部开票行')}>{fmtCents(report.totals![metric])}</button></td>)}</tr> : null}
        </tbody>
      </table>
    </div>
  </>;
}
