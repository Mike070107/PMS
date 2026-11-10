import { fmtCents, statusText } from '@/lib/statistics';
import type { TicketsResponse } from '@/lib/statistics';

const STATUS_TONE: Record<string, string> = { issued: 'ok', pre_issue: 'blue', voided: 'mute', written_off: 'acc' };

/** 票据情况统计：16 列 + 合计行（件数/金额/税额）。 */
export default function TicketsTable({ report, onOpen }: { report: TicketsResponse; onOpen?: (row: TicketsResponse['rows'][number]) => void }) {
  return (
    <div className="t-scroll stats-tickets-scroll">
      <table className="t stats-tickets-table" data-testid="tickets-table">
        <thead>
          <tr>
            <th>序号</th><th>票据编号</th><th>入库单编号</th><th>管理处</th><th>开票日期</th><th>付款人</th>
            <th className="num">金额</th><th className="num">税额</th><th>收款日期</th><th>开票人</th><th>收款人</th>
            <th>作废日期</th><th>核销日期</th><th>收款方式</th><th>发票号</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.id}-${index}`} data-ticket-id={row.id} data-status={row.status}>
              <td className="muted">{index + 1}</td>
              <td>{onOpen ? <button type="button" className="stats-money-btn stats-cell-link" aria-label={`查看票据 ${row.ticketNo || row.id} 开票明细`} onClick={() => onOpen(row)}>{row.ticketNo || '未编号票据'} · 明细</button> : <b>{row.ticketNo || '—'}</b>}</td>
              <td>{row.warehouseNo || '—'}</td>
              <td>{row.officeName || row.officeCode}</td>
              <td>{row.issueDate || '—'}</td>
              <td>{row.payer || '—'}</td>
              <td className="num">{fmtCents(row.amountCents)}</td>
              <td className="num">{fmtCents(row.taxCents)}</td>
              <td>{row.receiptDate || '—'}</td>
              <td>{row.issuer || '—'}</td>
              <td>{row.payee || '—'}</td>
              <td>{row.voidDate || '—'}</td>
              <td>{row.writeoffDate || '—'}</td>
              <td>{row.paymentMethod || '—'}</td>
              <td>{row.invoiceNo || '—'}</td>
              <td><span className={`tag ${STATUS_TONE[row.status] || 'mute'}`}>{statusText(row.status)}</span></td>
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="tickets-total">
              <td colSpan={6}><b>合计（{report.totals.count ?? report.rows.length} 件）</b></td>
              <td className="num"><b>{fmtCents(report.totals.amountCents)}</b></td>
              <td className="num"><b>{fmtCents(report.totals.taxCents)}</b></td>
              <td colSpan={8} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
