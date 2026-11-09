import { fmtArea } from '@/lib/statistics';
import type { PropertySummaryCounts, PropertySummaryResponse } from '@/lib/statistics';

function area(value: number | string | null | undefined): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) && value !== null && value !== '' ? fmtArea(numeric) : '—';
}
function count(value: number | undefined | null): string {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

/** 房产汇总：行=管理处 + 合计；列=楼栋/房屋/业主/面积 + 各房屋性质房屋数。 */
export default function PropertySummaryTable({ report }: { report: PropertySummaryResponse }) {
  const counts = (row: PropertySummaryCounts) => [
    count(row.buildingCount), count(row.roomCount), count(row.ownerCount), area(row.totalAreaSqm),
    ...report.natures.map((nature) => count(row.natureCounts?.[nature.code])),
  ];
  return (
    <div className="t-scroll stats-property-scroll">
      <table className="t stats-property-table" data-testid="property-summary-table">
        <thead>
          <tr>
            <th>管理处</th><th className="num">楼栋数</th><th className="num">房屋数</th><th className="num">业主数</th><th className="num">建筑面积</th>
            {report.natures.map((nature) => <th key={nature.code} className="num" title={nature.name}>{nature.code} {nature.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.officeCode} data-office-row={row.officeCode}>
              <td><b>{row.officeName || row.officeCode}</b></td>
              {counts(row).map((text, index) => <td key={index} className="num">{text}</td>)}
            </tr>
          ))}
          {report.total ? (
            <tr className="stats-subtotal-row" data-testid="property-summary-total">
              <td><b>合计</b></td>
              {counts(report.total).map((text, index) => <td key={index} className="num"><b>{text}</b></td>)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
