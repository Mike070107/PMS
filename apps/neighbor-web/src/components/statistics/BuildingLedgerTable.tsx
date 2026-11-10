import { fmtArea } from '@/lib/statistics';
import type { BuildingLedgerResponse } from '@/lib/statistics';

const EMPTY = '—';
const text = (value: string | null | undefined) => (value === null || value === undefined || String(value).trim() === '' ? EMPTY : String(value));

/** 楼房台账：行=楼栋；房屋数/业主数/面积 + 合计行。 */
export default function BuildingLedgerTable({ report }: { report: BuildingLedgerResponse }) {
  return (
    <div className="t-scroll stats-ledger-scroll">
      <table className="t stats-building-ledger-table" data-testid="building-ledger-table">
        <thead>
          <tr>
            <th>序号</th><th>管理处</th><th>路</th><th>弄/号</th><th>楼号</th><th className="num">房屋数</th><th className="num">业主数</th><th className="num">建筑面积</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.lId ?? 'x'}-${index}`} data-l-id={row.lId ?? undefined}>
              <td className="muted">{index + 1}</td>
              <td>{row.officeName || row.officeCode}</td>
              <td>{text(row.road)}</td>
              <td>{text(row.lane)}</td>
              <td><b>{text(row.buildingNo)}</b></td>
              <td className="num">{row.roomCount}</td>
              <td className="num">{row.ownerCount}</td>
              <td className="num">{fmtArea(row.areaSqm)}</td>
            </tr>
          ))}
          {report.totals ? (
            <tr className="stats-subtotal-row stats-total-row" data-testid="building-ledger-total">
              <td colSpan={5}><b>合计</b></td>
              <td className="num"><b>{report.totals.roomCount ?? report.rows.reduce((sum, row) => sum + row.roomCount, 0)}</b></td>
              <td className="num"><b>{report.totals.ownerCount ?? report.rows.reduce((sum, row) => sum + row.ownerCount, 0)}</b></td>
              <td className="num"><b>{fmtArea(report.totals.areaSqm ?? 0)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
