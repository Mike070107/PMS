import { fmtArea } from '@/lib/statistics';
import type { OwnerLedgerResponse } from '@/lib/statistics';

const EMPTY = '—';
const text = (value: string | null | undefined) => (value === null || value === undefined || String(value).trim() === '' ? EMPTY : String(value));

/** 住户台账：按管理处/性质/关键词查住户，空值显示「—」。 */
export default function OwnerLedgerTable({ report }: { report: OwnerLedgerResponse }) {
  return (
    <div className="t-scroll stats-ledger-scroll">
      <table className="t stats-owner-ledger-table" data-testid="owner-ledger-table">
        <thead>
          <tr>
            <th>序号</th><th>管理处</th><th>地址</th><th>房号</th><th>业主</th><th>手机</th><th>电话</th><th className="num">建筑面积</th><th>房屋性质</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.sId ?? 'x'}-${index}`} data-s-id={row.sId ?? undefined}>
              <td className="muted">{index + 1}</td>
              <td>{row.officeName || row.officeCode}</td>
              <td><b>{text(row.address)}</b></td>
              <td>{text(row.roomNo)}</td>
              <td>{text(row.ownerName)}</td>
              <td>{text(row.mobile)}</td>
              <td>{text(row.phone2)}</td>
              <td className="num">{row.areaSqm === null || row.areaSqm === undefined || row.areaSqm === '' ? EMPTY : fmtArea(row.areaSqm)}</td>
              <td>{text(row.natureName || row.natureCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
