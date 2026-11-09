import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import {
  collectionAnalysisDetailParams, fmtCents, fmtPeriod,
  type CollectionAnalysisDetailResponse, type CollectionAnalysisDetailRow, type CollectionAnalysisQuery,
} from '@/lib/statistics';

export interface AnalysisDetailTarget {
  sId: number | null;
  address: string | null;
  ownerName: string | null;
}

const KIND_TAG: Record<CollectionAnalysisDetailRow['rowKind'], { text: string; tone: string }> = {
  received: { text: '收款', tone: 'ok' },
  refund: { text: '退款', tone: 'warn' },
  adjust: { text: '调整', tone: 'blue' },
  unpaid: { text: '欠收', tone: 'dang' },
};
const LIMIT = 200;

function kindCents(totals: CollectionAnalysisDetailResponse['totals'], kind: keyof NonNullable<CollectionAnalysisDetailResponse['totals']>): number {
  return Number(totals?.[kind] ?? 0);
}

/** 收款分析「点行」：该户逐笔明细，合计按类型分组。 */
export default function CollectionAnalysisDetailSheet({ open, onClose, base, target }: {
  open: boolean;
  onClose: () => void;
  base: CollectionAnalysisQuery | null;
  target: AnalysisDetailTarget | null;
}) {
  const [rows, setRows] = useState<CollectionAnalysisDetailRow[]>([]);
  const [totals, setTotals] = useState<CollectionAnalysisDetailResponse['totals']>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !base || !target) return undefined;
    let cancelled = false;
    setLoading(true); setError(''); setRows([]); setTotals(null); setCount(null);
    request<CollectionAnalysisDetailResponse>({
      url: '/statistics/collection-analysis/detail',
      query: collectionAnalysisDetailParams(base, target.sId),
    })
      .then((response) => {
        if (cancelled) return;
        setRows(Array.isArray(response.rows) ? response.rows : []);
        setTotals(response.totals ?? null);
        setCount(response.count ?? null);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error && e.message ? e.message : '逐笔明细读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, base, target]);

  const loadMore = async () => {
    if (!base || !target || loadingMore) return;
    setLoadingMore(true);
    try {
      const offset = rows.length;
      const response = await request<CollectionAnalysisDetailResponse>({
        url: '/statistics/collection-analysis/detail',
        query: { ...collectionAnalysisDetailParams(base, target.sId), offset, limit: LIMIT },
      });
      setRows((previous) => [...previous, ...(response.rows ?? [])]);
      setTotals(response.totals ?? null);
      setCount(response.count ?? null);
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    } finally { setLoadingMore(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} width={1080} title="该户逐笔明细" subtitle={target ? `${target.address || ''} · ${target.ownerName || ''}` : ''}>
      {target ? (
        <>
          <div className="stats-detail-tools">
            <span className="muted" data-testid="analysis-detail-summary">共 {count ?? rows.length} 笔</span>
            <span className="stats-summary-chips" data-testid="analysis-detail-totals">
              <span className="stats-summary-chip">收款 <b>{fmtCents(kindCents(totals, 'receivedCents'))}</b></span>
              <span className="stats-summary-chip">退款 <b>{fmtCents(kindCents(totals, 'refundCents'))}</b></span>
              <span className="stats-summary-chip">调整 <b>{fmtCents(kindCents(totals, 'adjustCents'))}</b></span>
              <span className="stats-summary-chip">欠收 <b>{fmtCents(kindCents(totals, 'unpaidCents'))}</b></span>
            </span>
          </div>
          <div className="note2" style={{ marginBottom: 10 }}><Icon name="alert" />类型汇总合计=该户当前筛选下的逐笔合计；加载更多每次 200 条。</div>
          {error ? (
            <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{error}</div>
          ) : loading ? <Loading text="读逐笔明细…" /> : !rows.length ? <div className="empty">该户没有逐笔明细</div> : (
            <>
              <div className="t-scroll stats-detail-scroll">
                <table className="t stats-analysis-detail-table" data-testid="analysis-detail-table">
                  <thead>
                    <tr><th>所属年月</th><th>收费项目</th><th className="num">金额</th><th>收款日期</th><th>退款日期</th><th>方式</th><th>收款人</th><th>类型</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const tag = KIND_TAG[row.rowKind] ?? { text: row.rowKind, tone: 'mute' };
                      return (
                        <tr key={`${row.zjId}-${index}`} data-row-kind={row.rowKind}>
                          <td>{fmtPeriod(row.period)}</td>
                          <td>{row.feeName || row.feeCode || '—'}</td>
                          <td className="num">{fmtCents(row.amountCents)}</td>
                          <td>{row.paidDate || '—'}</td>
                          <td>{row.refundDate || '—'}</td>
                          <td>{row.paymentMethod || '—'}</td>
                          <td>{row.cashier || '—'}</td>
                          <td><span className={`tag ${tag.tone}`}>{tag.text}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {count != null && rows.length < count ? (
                <div className="stats-load-more">
                  <button type="button" className="btn sm" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? '加载中…' : `加载更多（已显示 ${rows.length}/${count}）`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </Sheet>
  );
}
