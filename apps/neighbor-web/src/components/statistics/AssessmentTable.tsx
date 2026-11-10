import { fmtArea, fmtCents, type AssessmentMonth, type AssessmentResponse } from '@/lib/statistics';

function monthValue(months: AssessmentMonth[], month: number, key: 'receivableCents' | 'receivedCents'): number {
  return Number(months.find((item) => String(item.month) === String(month))?.[key] ?? 0);
}
/** 月列纯数字：千分位 + 两位小数；0 用灰色「—」。 */
function amountText(cents: number): string {
  if (!cents) return '—';
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtRate(value: number | null | undefined): string {
  return `${(Number(value) || 0).toFixed(2)}%`;
}
/** 收缴率阈值：≥95 绿 / 80–95 琥珀 / <80 红 / 无应收灰。 */
function rateClass(rate: number | null | undefined, receivable: number): string {
  if (!receivable) return 'stats-rate-muted';
  const value = Number(rate) || 0;
  if (value >= 95) return 'stats-rate-pos';
  if (value >= 80) return 'stats-rate-warn';
  return 'stats-rate-neg';
}
function rateTitle(rate: number, receivable: number): string {
  if (!receivable) return '无应收，不计算收缴率';
  return `收缴率 ${(Number(rate) || 0).toFixed(2)}%；阈值：≥95% 绿、80%–95% 琥珀、<80% 红`;
}
/** 收款语义：等于应收=已收齐（绿）、少于应收=有欠收（红）、超过应收=预收（蓝）、均 0=无数据（灰）。 */
function receivedState(receivable: number, received: number): 'equal' | 'less' | 'over' | 'zero' | 'unpaid' {
  if (receivable === 0 && received === 0) return 'zero';
  if (received > receivable) return 'over';
  if (received === receivable) return 'equal';
  if (received === 0) return 'unpaid';
  return 'less';
}
const STATE_CLASS: Record<string, string> = {
  equal: 'stats-num-pos', less: 'stats-num-neg', unpaid: 'stats-num-neg stats-cell-neg-tint', over: 'stats-num-info',
};

/** 收缴考核：行=房屋，列=1–12 月应收/收款 + 合计 + 收缴率；首三列/表头 sticky，语义色+图例。 */
export default function AssessmentTable({ report }: { report: AssessmentResponse }) {
  return (
    <div className="stats-assessment-wrap">
      <div className="t-scroll stats-assessment-scroll">
        <table className="t stats-assessment-table" data-testid="assessment-table">
          <thead>
            <tr>
              <th className="stats-sticky-name" rowSpan={2}>地址</th>
              <th className="stats-sticky-owner" rowSpan={2}>住户</th>
              <th className="num stats-sticky-area" rowSpan={2}>建筑面积</th>
              {Array.from({ length: 12 }, (_, index) => (
                <th key={index} colSpan={2} className={`stats-month-head ${index % 2 === 0 ? 'stats-month-odd' : 'stats-month-even'}`}>{index + 1} 月（元）</th>
              ))}
              <th className="num stats-p2-total-col" rowSpan={2}>合计应收</th>
              <th className="num stats-p2-total-col" rowSpan={2}>合计已收</th>
              <th className="num stats-p2-net-col" rowSpan={2}>收缴率</th>
            </tr>
            <tr>
              {Array.from({ length: 12 }, (_, index) => (
                <th key={`recv-${index}`} className="num stats-month-sub stats-subhead-recv">应收</th>
              )).flatMap((header, index) => [
                header,
                <th key={`paid-${index}`} className="num stats-month-sub stats-subhead-paid">收款</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, index) => (
              <tr key={`${row.sId ?? 'x'}-${row.officeCode}-${index}`} data-s-id={row.sId ?? undefined}>
                <td className="stats-sticky-name"><b>{row.address || '—'}</b></td>
                <td className="stats-sticky-owner">{row.ownerName || '—'}</td>
                <td className="num stats-sticky-area">{fmtArea(row.areaSqm)}</td>
                {Array.from({ length: 12 }, (_, monthIndex) => {
                  const receivable = monthValue(row.months, monthIndex + 1, 'receivableCents');
                  const received = monthValue(row.months, monthIndex + 1, 'receivedCents');
                  const state = receivedState(receivable, received);
                  return [
                    <td key={`r-${monthIndex}`} className={`num stats-cell-month${receivable === 0 ? ' stats-num-muted' : ''}`} data-receivable={receivable} data-zero={receivable === 0 ? 'true' : undefined}>
                      {amountText(receivable)}
                    </td>,
                    <td
                      key={`p-${monthIndex}`}
                      className={`num stats-cell-month ${received === 0 && receivable === 0 ? 'stats-num-muted' : STATE_CLASS[state] || ''}`}
                      data-received-state={state}
                      title={state === 'over' ? '超出应收（预收）' : state === 'unpaid' ? '应收未收（欠收）' : undefined}
                    >
                      {amountText(received)}
                    </td>,
                  ];
                })}
                <td className="num stats-p2-total-col"><b>{fmtCents(row.totalReceivableCents)}</b></td>
                <td className={`num stats-p2-total-col ${receivedState(row.totalReceivableCents, row.totalReceivedCents) === 'equal' || row.totalReceivedCents > row.totalReceivableCents ? 'stats-num-pos' : row.totalReceivedCents < row.totalReceivableCents ? 'stats-num-neg' : 'stats-num-muted'}`}>
                  <b>{row.totalReceivedCents === 0 && row.totalReceivableCents === 0 ? '—' : fmtCents(row.totalReceivedCents)}</b>
                </td>
                <td className={`num stats-p2-net-col ${rateClass(row.ratePct, row.totalReceivableCents)}`} title={rateTitle(row.ratePct, row.totalReceivableCents)}>
                  <b>{row.totalReceivableCents ? fmtRate(row.ratePct) : '—'}</b>
                </td>
              </tr>
            ))}
            {report.summary ? (
              <tr className="stats-subtotal-row stats-total-row" data-testid="assessment-total">
                <td className="stats-sticky-name" colSpan={3}><b>合计</b></td>
                {Array.from({ length: 12 }, (_, monthIndex) => {
                  const receivable = report.rows.reduce((sum, row) => sum + monthValue(row.months, monthIndex + 1, 'receivableCents'), 0);
                  const received = report.rows.reduce((sum, row) => sum + monthValue(row.months, monthIndex + 1, 'receivedCents'), 0);
                  const state = receivedState(receivable, received);
                  return [
                    <td key={`tr-${monthIndex}`} className={`num${receivable === 0 ? ' stats-num-muted' : ''}`}>{amountText(receivable)}</td>,
                    <td key={`tp-${monthIndex}`} className={`num ${received === 0 && receivable === 0 ? 'stats-num-muted' : STATE_CLASS[state] || ''}`} data-received-state={state}>{amountText(received)}</td>,
                  ];
                })}
                <td className="num stats-p2-total-col"><b>{fmtCents(report.summary.receivableCents)}</b></td>
                <td className={`num stats-p2-total-col ${report.summary.receivedCents >= report.summary.receivableCents && report.summary.receivableCents > 0 ? 'stats-num-pos' : report.summary.receivedCents < report.summary.receivableCents ? 'stats-num-neg' : 'stats-num-muted'}`}><b>{fmtCents(report.summary.receivedCents)}</b></td>
                <td className={`num stats-p2-net-col ${rateClass(report.summary.ratePct, report.summary.receivableCents)}`} title={rateTitle(report.summary.ratePct, report.summary.receivableCents)}>
                  <b>{report.summary.receivableCents ? fmtRate(report.summary.ratePct) : '—'}</b>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="stats-assessment-legend" data-testid="assessment-legend">
        <span className="stats-num-pos">绿色 = 已收齐</span>
        <span className="stats-num-neg">红色 = 有欠收</span>
        <span className="stats-num-info">蓝色 = 超过应收（预收）</span>
        <span className="stats-num-muted">灰色「—」= 无数据</span>
      </div>
    </div>
  );
}
