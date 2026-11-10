import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, Sheet } from '@/components/ui';
import { arrearsBillsParams, fmtCents, fmtPeriod, type ArrearsBillsResponse, type ArrearsPrepaidQuery } from '@/lib/statistics';

export interface ArrearsBillsTarget {
  sId: number | null;
  feeCode: string;
  feeName: string | null;
  address: string | null;
  amountCents: number;
}

/** 欠收/溢收「查看」：该户该费项逐笔明细，合计=行金额。 */
export default function ArrearsBillsSheet({ open, onClose, base, target }: {
  open: boolean;
  onClose: () => void;
  base: ArrearsPrepaidQuery | null;
  target: ArrearsBillsTarget | null;
}) {
  const [rows, setRows] = useState<ArrearsBillsResponse['rows']>([]);
  const [totalCents, setTotalCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!open || !base || !target) return undefined;
    let cancelled = false;
    setLoading(true); setError(''); setRows([]); setTotalCents(null);
    request<ArrearsBillsResponse>({ url: '/statistics/arrears-prepaid/detail/bills', query: arrearsBillsParams(base, target) })
      .then((response) => {
        if (cancelled) return;
        if (response.available === false) {
          setError(response.message ? `逐笔明细尚未同步：${response.message}` : '逐笔明细尚未同步，请重试');
          return;
        }
        setRows(Array.isArray(response.rows) ? response.rows : []);
        setTotalCents(response.totalCents ?? null);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error && e.message ? e.message : '逐笔明细读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, base, target, retryTick]);

  return (
    <Sheet open={open} onClose={onClose} width={760} title="逐笔明细" subtitle={target ? `${target.address || ''} · ${target.feeName || target.feeCode}` : ''}>
      {target ? (
        <>
          <div className="note2" data-testid="arrears-bills-summary" style={{ marginBottom: 10 }}>
            <Icon name="alert" />明细合计 {totalCents == null ? '—' : fmtCents(totalCents)}（待核对行金额 {fmtCents(target.amountCents)}）。
          </div>
          {error ? (
            <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
              <Icon name="alert" />{error}
              <button type="button" className="btn sm" data-testid="arrears-bills-retry" disabled={loading} onClick={() => setRetryTick((value) => value + 1)}>重试</button>
            </div>
          ) : loading ? <Loading text="读逐笔明细…" /> : !rows.length ? <div className="empty">没有逐笔明细</div> : (
            <div className="t-scroll">
              <table className="t stats-arrears-bills-table" data-testid="arrears-bills-table">
                <thead><tr><th>所属年月</th><th className="num">金额</th><th>收款日期</th><th>退款日期</th></tr></thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.zjId}-${index}`}>
                      <td>{fmtPeriod(row.period)}</td>
                      <td className="num">{fmtCents(row.amountCents)}</td>
                      <td>{row.paidDate || '—'}</td>
                      <td>{row.refundDate || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </Sheet>
  );
}
