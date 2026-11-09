import { fmtCents } from '@/lib/statistics';
import type { FeeNatureResponse } from '@/lib/statistics';

export interface FeeNatureCellTarget {
  feeCode: string;
  feeName: string;
  natureCode?: string;
  kind: 'all' | 'received' | 'refund' | 'adjust';
}

/** 收费汇总：行=收费项目、列=房屋性质净额；行尾收款/退款/调整/净额；点击金额下钻。 */
export default function FeeNatureTable({ report, onCellClick }: {
  report: FeeNatureResponse;
  onCellClick: (target: FeeNatureCellTarget) => void;
}) {
  const amount = (cents: number, target: FeeNatureCellTarget) => (
    <button
      type="button"
      className="stats-money-btn"
      data-kind={target.kind}
      data-fee-code={target.feeCode}
      data-nature-code={target.natureCode ?? undefined}
      title="查看逐笔明细"
      onClick={() => onCellClick(target)}
    >{fmtCents(cents)}</button>
  );
  const subtotal = report.subtotal;
  return (
    <div className="t-scroll stats-matrix-scroll">
      <table className="t stats-fee-nature-table" data-testid="fee-nature-table">
        <thead>
          <tr>
            <th className="stats-sticky-name">收费项目</th>
            {report.columns.map((column) => (
              <th key={column.code} className="num" title={column.name}>{column.code} {column.name}</th>
            ))}
            <th className="num stats-p2-total-col">收款</th>
            <th className="num stats-p2-total-col">退款</th>
            <th className="num stats-p2-total-col">调整</th>
            <th className="num stats-p2-total-col stats-p2-net-col">净额</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.feeCode} data-fee-row={row.feeCode}>
              <td className="stats-sticky-name"><b>{row.feeName || row.feeCode}</b></td>
              {report.columns.map((column) => {
                const cents = Number(row.cells?.[column.code] ?? 0);
                return (
                  <td key={column.code} className="num">
                    {amount(cents, { feeCode: row.feeCode, feeName: row.feeName, natureCode: column.code, kind: 'all' })}
                  </td>
                );
              })}
              <td className="num stats-p2-total-col">{amount(row.receivedCents, { feeCode: row.feeCode, feeName: row.feeName, kind: 'received' })}</td>
              <td className="num stats-p2-total-col">{amount(row.refundCents, { feeCode: row.feeCode, feeName: row.feeName, kind: 'refund' })}</td>
              <td className="num stats-p2-total-col">{amount(row.adjustCents, { feeCode: row.feeCode, feeName: row.feeName, kind: 'adjust' })}</td>
              <td className="num stats-p2-total-col stats-p2-net-col">{amount(row.netCents, { feeCode: row.feeCode, feeName: row.feeName, kind: 'all' })}</td>
            </tr>
          ))}
          {subtotal ? (
            <tr className="stats-subtotal-row" data-testid="fee-nature-subtotal">
              <td className="stats-sticky-name"><b>总计</b></td>
              {report.columns.map((column) => (
                <td key={column.code} className="num"><b>{fmtCents(Number(subtotal.cells?.[column.code] ?? 0))}</b></td>
              ))}
              <td className="num stats-p2-total-col"><b>{fmtCents(subtotal.receivedCents)}</b></td>
              <td className="num stats-p2-total-col"><b>{fmtCents(subtotal.refundCents)}</b></td>
              <td className="num stats-p2-total-col"><b>{fmtCents(subtotal.adjustCents)}</b></td>
              <td className="num stats-p2-total-col stats-p2-net-col"><b>{fmtCents(subtotal.netCents)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
