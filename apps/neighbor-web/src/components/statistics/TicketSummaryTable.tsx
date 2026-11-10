import { fmtCents } from '@/lib/statistics';
import type { TicketSummaryResponse } from '@/lib/statistics';

/** 收款汇总表：主表（费项×收款方式动态列 + 合计）+ 票据口径副表 + 按收款人副表。 */
export default function TicketSummaryTable({ report }: { report: TicketSummaryResponse }) {
  const totals = report.totals;
  return (
    <div className="stats-ticket-summary">
      <div className="t-scroll stats-ticket-summary-scroll">
        <table className="t stats-ticket-summary-table" data-testid="ticket-summary-table">
          <thead>
            <tr>
              <th>收费项目</th>
              {report.methodColumns.map((column) => <th key={column.key} className="num">{column.label}</th>)}
              <th className="num stats-p2-total-col">合计</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.feeCode} data-fee-code={row.feeCode}>
                <td><b>{row.feeName || row.feeCode}</b></td>
                {report.methodColumns.map((column) => <td key={column.key} className="num">{fmtCents(Number(row.methods?.[column.key] ?? 0))}</td>)}
                <td className="num stats-p2-total-col"><b>{fmtCents(row.netCents)}</b></td>
              </tr>
            ))}
            {totals ? (
              <tr className="stats-subtotal-row" data-testid="ticket-summary-total">
                <td><b>合计</b></td>
                {report.methodColumns.map((column) => <td key={column.key} className="num"><b>{fmtCents(Number(totals.methods?.[column.key] ?? 0))}</b></td>)}
                <td className="num stats-p2-total-col"><b>{fmtCents(totals.netCents)}</b></td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section className="stats-subblock">
        <div className="panelHd" style={{ marginBottom: 8 }}>
          <b>票据口径</b><span className="muted">开票数据，与收款金额口径不同</span>
        </div>
        <div className="t-scroll">
          <table className="t stats-ticket-summary-ticket-table" data-testid="ticket-summary-ticket-table">
            <thead><tr><th>收费项目</th><th className="num">票据金额</th><th className="num">税额</th><th className="num">不含税收入</th><th className="num">票据张数</th></tr></thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.feeCode}>
                  <td>{row.feeName || row.feeCode}</td>
                  <td className="num">{fmtCents(row.ticketAmountCents)}</td>
                  <td className="num">{fmtCents(row.ticketTaxCents)}</td>
                  <td className="num">{fmtCents(row.ticketIncomeCents)}</td>
                  <td className="num">{row.ticketCount}</td>
                </tr>
              ))}
              {totals ? (
                <tr className="stats-subtotal-row">
                  <td><b>合计</b></td>
                  <td className="num"><b>{fmtCents(totals.ticketAmountCents)}</b></td>
                  <td className="num"><b>{fmtCents(totals.ticketTaxCents)}</b></td>
                  <td className="num"><b>{fmtCents(totals.ticketIncomeCents)}</b></td>
                  <td className="num"><b>{totals.ticketCount}</b></td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stats-subblock">
        <div className="panelHd" style={{ marginBottom: 8 }}>
          <b>其中：按收款人</b><span className="muted">收款人 × 收款方式 × 合计 × 笔数</span>
        </div>
        <div className="t-scroll">
          <table className="t stats-ticket-summary-cashier-table" data-testid="ticket-summary-cashier-table">
            <thead>
              <tr><th>收款人</th>{report.methodColumns.map((column) => <th key={column.key} className="num">{column.label}</th>)}<th className="num">合计</th><th className="num">笔数</th></tr>
            </thead>
            <tbody>
              {report.cashierRows.map((row) => (
                <tr key={row.cashier} data-cashier={row.cashier}>
                  <td><b>{row.cashier || '未填'}</b></td>
                  {report.methodColumns.map((column) => <td key={column.key} className="num">{fmtCents(Number(row.methods?.[column.key] ?? 0))}</td>)}
                  <td className="num"><b>{fmtCents(row.netCents)}</b></td>
                  <td className="num">{row.rows}</td>
                </tr>
              ))}
              {report.cashierTotals ? (
                <tr className="stats-subtotal-row" data-testid="ticket-summary-cashier-total">
                  <td><b>合计</b></td>
                  {report.methodColumns.map((column) => <td key={column.key} className="num"><b>{fmtCents(Number(report.cashierTotals?.methods?.[column.key] ?? 0))}</b></td>)}
                  <td className="num"><b>{fmtCents(report.cashierTotals.netCents)}</b></td>
                  <td className="num"><b>{report.cashierTotals.rows}</b></td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
