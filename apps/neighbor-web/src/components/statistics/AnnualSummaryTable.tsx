import type { AnnualSummaryResponse } from '@/lib/statistics';
import { cellCents, fmtCents } from '@/lib/statistics';

export interface AnnualCellTarget {
  officeCode: string;
  officeName: string;
  year: number;
  amountCents: number;
}

/**
 * 年度汇总表：编号列 + 管理处列固定左侧、年度列横向滚动、合计列固定右侧并高亮、底部小计。
 * 数值列表头/单元格统一右对齐，文本列统一左对齐（编号列居中），单元格加表格线。
 * 窄屏（≤760px）由 CSS 切换成卡片列表，桌面表格隐藏，避免横向溢出。
 */
export default function AnnualSummaryTable({
  annual, onCellClick,
}: {
  annual: AnnualSummaryResponse;
  onCellClick: (target: AnnualCellTarget) => void;
}) {
  const subtotal = annual.subtotal ?? { cells: {}, totalCents: 0 };
  return (
    <>
      <div className="t-scroll stats-table-scroll" data-testid="stats-annual-scroll">
        <table className="t stats-annual-table">
          <thead>
            <tr>
              <th className="stats-index-col">编号</th>
              <th className="stats-office-col">管理处</th>
              {annual.columns.map((year) => <th key={year} className="stats-year-col">{year}</th>)}
              <th className="stats-total-col">合计</th>
            </tr>
          </thead>
          <tbody>
            {annual.rows.map((row) => (
              <tr key={row.officeCode} data-office-row={row.officeCode}>
                <td className="stats-index-col">{row.officeCode}</td>
                <td className="stats-office-col"><b>{row.officeName || row.officeCode}</b></td>
                {annual.columns.map((year) => {
                  const cents = cellCents(row, year);
                  return (
                    <td key={year} className={`stats-year-col${cents ? '' : ' is-zero'}`}>
                      <button
                        type="button"
                        className="stats-cell"
                        data-office-code={row.officeCode}
                        data-year={year}
                        title={`${row.officeName || row.officeCode} ${year} 年度明细 ${fmtCents(cents)}`}
                        onClick={() => onCellClick({ officeCode: row.officeCode, officeName: row.officeName || row.officeCode, year, amountCents: cents })}
                      >{fmtCents(cents)}</button>
                    </td>
                  );
                })}
                <td className="stats-total-col"><b>{fmtCents(row.totalCents)}</b></td>
              </tr>
            ))}
            <tr className="stats-subtotal-row stats-total-row" data-testid="stats-subtotal-row">
              <td className="stats-index-col" />
              <td className="stats-office-col"><b>小计</b></td>
              {annual.columns.map((year) => (
                <td key={year} className="stats-year-col"><b>{fmtCents(cellCents(subtotal, year))}</b></td>
              ))}
              <td className="stats-total-col"><b>{fmtCents(subtotal.totalCents)}</b></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="stats-annual-cards" data-testid="stats-annual-cards">
        {annual.rows.map((row) => (
          <article key={row.officeCode} className="card stats-office-card" data-office-card={row.officeCode}>
            <header>
              <b>{row.officeName || row.officeCode}</b>
              <span className="tag mute">{row.officeCode}</span>
            </header>
            <div className="stats-card-total">
              <span>合计</span>
              <b>{fmtCents(row.totalCents)}</b>
            </div>
            <div className="stats-card-years">
              {annual.columns.map((year) => {
                const cents = cellCents(row, year);
                return (
                  <button
                    key={year}
                    type="button"
                    className={`stats-card-year${cents ? '' : ' is-zero'}`}
                    data-office-code={row.officeCode}
                    data-year={year}
                    onClick={() => onCellClick({ officeCode: row.officeCode, officeName: row.officeName || row.officeCode, year, amountCents: cents })}
                  >
                    <span>{year}</span>
                    <b>{fmtCents(cents)}</b>
                  </button>
                );
              })}
            </div>
          </article>
        ))}
        <div className="card stats-subtotal-card" data-testid="stats-subtotal-card">
          <span>小计</span>
          <b>{fmtCents(subtotal.totalCents)}</b>
        </div>
      </div>
    </>
  );
}
