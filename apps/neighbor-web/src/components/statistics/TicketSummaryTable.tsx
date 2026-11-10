import { fmtCents, ticketSummaryTicketReady } from '@/lib/statistics';
import type { TicketSummaryResponse } from '@/lib/statistics';

const money = (cents: number | null) => (cents == null ? '—' : fmtCents(cents));
const moneyClass = (cents: number) => (cents === 0 ? 'stats-num-muted' : cents < 0 ? 'stats-num-neg' : '');

/** 收款汇总表：主表（费项×收款方式动态列 + 合计）+ 票据口径副表 + 按收款人副表。 */
export default function TicketSummaryTable({ report }: { report: TicketSummaryResponse }) {
  const totals = report.totals;
  const ticketsReady = ticketSummaryTicketReady(report);
  const ticketMoney = (cents: number | null) => money(ticketsReady ? cents : null);
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
                {report.methodColumns.map((column) => {
                  const cents = Number(row.methods?.[column.key] ?? 0);
                  return <td key={column.key} className={`num ${moneyClass(cents)}`}>{money(cents)}</td>;
                })}
                <td className={`num stats-p2-total-col ${moneyClass(row.netCents)}`}><b>{money(row.netCents)}</b></td>
              </tr>
            ))}
            {totals ? (
              <tr className="stats-subtotal-row stats-total-row" data-testid="ticket-summary-total">
                <td><b>合计</b></td>
                {report.methodColumns.map((column) => {
                  const cents = Number(totals.methods?.[column.key] ?? 0);
                  return <td key={column.key} className={`num ${moneyClass(cents)}`}><b>{money(cents)}</b></td>;
                })}
                <td className={`num stats-p2-total-col ${moneyClass(totals.netCents)}`}><b>{money(totals.netCents)}</b></td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section className="stats-subblock">
        <div className="panelHd" style={{ marginBottom: 8 }}>
          <b>票据口径</b><span className="muted">开票数据，与收款金额口径不同</span>
        </div>
        {!ticketsReady ? <p className="muted" role="status">票据或开票明细镜像未就绪，金额、税额、不含税收入及张数显示「—」（未知，并非 0）；收款及收款人数据仍可查看和导出。</p> : null}
        <div className="t-scroll">
          <table className="t stats-ticket-summary-ticket-table" data-testid="ticket-summary-ticket-table">
            <thead><tr><th>收费项目</th><th className="num">票据金额</th><th className="num">税额</th><th className="num">不含税收入</th><th className="num">票据张数</th></tr></thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.feeCode}>
                  <td>{row.feeName || row.feeCode}</td>
                  <td className="num">{ticketMoney(row.ticketAmountCents)}</td>
                  <td className="num">{ticketMoney(row.ticketTaxCents)}</td>
                  <td className="num">{ticketMoney(row.ticketIncomeCents)}</td>
                  <td className={`num ${row.ticketCount === 0 ? 'stats-num-muted' : ''}`}>{ticketsReady ? row.ticketCount : '—'}</td>
                </tr>
              ))}
              {totals ? (
                <tr className="stats-subtotal-row stats-total-row">
                  <td><b>合计</b></td>
                  <td className="num"><b>{ticketMoney(totals.ticketAmountCents)}</b></td>
                  <td className="num"><b>{ticketMoney(totals.ticketTaxCents)}</b></td>
                  <td className="num"><b>{ticketMoney(totals.ticketIncomeCents)}</b></td>
                  <td className="num"><b>{ticketsReady ? totals.ticketCount : '—'}</b></td>
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
                  {report.methodColumns.map((column) => {
                    const cents = Number(row.methods?.[column.key] ?? 0);
                    return <td key={column.key} className={`num ${moneyClass(cents)}`}>{money(cents)}</td>;
                  })}
                  <td className={`num ${moneyClass(row.netCents)}`}><b>{money(row.netCents)}</b></td>
                  <td className="num">{row.rows}</td>
                </tr>
              ))}
              {report.cashierTotals ? (
                <tr className="stats-subtotal-row stats-total-row" data-testid="ticket-summary-cashier-total">
                  <td><b>合计</b></td>
                  {report.methodColumns.map((column) => {
                    const cents = Number(report.cashierTotals?.methods?.[column.key] ?? 0);
                    return <td key={column.key} className={`num ${moneyClass(cents)}`}><b>{money(cents)}</b></td>;
                  })}
                  <td className={`num ${moneyClass(report.cashierTotals.netCents)}`}><b>{money(report.cashierTotals.netCents)}</b></td>
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
