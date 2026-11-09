import { fmtCents } from '@/lib/statistics';
import type { SignoffRow, SignoffsResponse } from '@/lib/statistics';

function statusOf(row: SignoffRow): { text: string; tone: string } {
  if (row.voided) return { text: '作废', tone: 'mute' };
  if (!row.ended) return { text: '未结束', tone: 'warn' };
  return { text: '生效', tone: 'ok' };
}

/** 签报情况统计：13 列，状态标签色（生效绿/作废灰/未结束橙），合计调整金额/件数。 */
export default function SignoffsTable({ report }: { report: SignoffsResponse }) {
  return (
    <div className="t-scroll stats-signoffs-scroll">
      <table className="t stats-signoffs-table" data-testid="signoffs-table">
        <thead>
          <tr>
            <th>序号</th><th>文号</th><th>标题</th><th>类型</th><th>管理处</th><th>地址</th><th>业主</th>
            <th>拟稿日期</th><th>审批日期</th><th>结果</th><th>是否作废</th><th>是否结束</th><th className="num">调整金额</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => {
            const status = statusOf(row);
            return (
              <tr key={`${row.id}-${index}`} data-signoff-id={row.id} data-status={row.voided ? 'voided' : row.ended ? 'effective' : 'open'}>
                <td className="muted">{index + 1}</td>
                <td>{row.docNo || '—'}</td>
                <td><b>{row.title || '—'}</b></td>
                <td><span className={`tag ${status.tone}`}>{status.text}</span> {row.type || '—'}</td>
                <td>{row.officeName || row.officeCode}</td>
                <td>{row.address || '—'}</td>
                <td>{row.ownerName || '—'}</td>
                <td>{row.draftDate || '—'}</td>
                <td>{row.approveDate || '—'}</td>
                <td>{row.result || '—'}</td>
                <td>{row.voided ? '是' : '否'}</td>
                <td>{row.ended ? '是' : '否'}</td>
                <td className="num"><b>{fmtCents(row.adjustAmountCents)}</b></td>
              </tr>
            );
          })}
          {report.totals ? (
            <tr className="stats-subtotal-row" data-testid="signoffs-total">
              <td colSpan={12}><b>合计（{report.totals.count ?? report.rows.length} 件 · 作废 {report.totals.voidedCount ?? 0} · 已结束 {report.totals.endedCount ?? 0}）</b></td>
              <td className="num"><b>{fmtCents(report.totals.adjustAmountCents)}</b></td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
