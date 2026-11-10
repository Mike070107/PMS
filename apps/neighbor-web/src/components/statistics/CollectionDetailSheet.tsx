import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, Sheet } from '@/components/ui';
import {
  collectionDetailParams, collectionDetailTotal, fmtCents, fmtPeriod, type CollectionDetailKind, type CollectionDetailResponse,
  type CollectionDetailRow, type ReportQuery,
} from '@/lib/statistics';

export interface CollectionDetailTarget {
  feeCode: string;
  feeName: string;
  natureCode?: string | null;
  natureName?: string | null;
  /** 日报表下钻固定到某一天 */
  date?: string | null;
  kind?: CollectionDetailKind;
}

const KIND_LABELS: Record<CollectionDetailKind, string> = { all: '全部类型', received: '收款', refund: '退款', adjust: '调整' };
const KIND_TAG: Record<CollectionDetailRow['rowKind'], { text: string; tone: string }> = {
  received: { text: '收款', tone: 'ok' },
  refund: { text: '退款', tone: 'warn' },
  adjust: { text: '调整', tone: 'blue' },
};

const LIMIT = 200;

/** 收费汇总/收款日报表下钻：逐笔收款/退款/调整明细，合计=所点单元格。 */
export default function CollectionDetailSheet({ open, onClose, base, target, reportLabel }: {
  open: boolean;
  onClose: () => void;
  base: ReportQuery | null;
  target: CollectionDetailTarget | null;
  reportLabel: string;
}) {
  const [kind, setKind] = useState<CollectionDetailKind>(target?.kind ?? (target?.date ? 'received' : 'all'));
  const [rows, setRows] = useState<CollectionDetailRow[]>([]);
  const [totalCents, setTotalCents] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [offset, setOffset] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    if (!open || !target) return;
    setKind(target.kind ?? (target.date ? 'received' : 'all'));
  }, [open, target]);

  useEffect(() => {
    if (!open || !base || !target) return undefined;
    const generation = ++generationRef.current;
    loadingMoreRef.current = false;
    setLoadingMore(false); setLoadMoreError('');
    setLoading(true); setError(''); setOffset(0); setRows([]); setTotalCents(null); setCount(null);
    const params = collectionDetailParams(base, { feeCode: target.feeCode, natureCode: target.natureCode, kind, date: target.date }, 0, LIMIT);
    request<CollectionDetailResponse>({ url: '/statistics/collection/detail', query: params })
      .then((response) => {
        if (generation !== generationRef.current) return;
        if (response.available === false) {
          // 未同步是「未知」，不能当成 0 笔/¥0.00，也不能用空行覆盖。
          setError(response.message ? `逐笔明细尚未同步：${response.message}` : '逐笔明细尚未同步，请重试');
          return;
        }
        setRows(Array.isArray(response.rows) ? response.rows : []);
        setTotalCents(collectionDetailTotal(response, kind));
        setCount(response.count ?? null);
      })
      .catch((e) => { if (generation === generationRef.current) setError(e instanceof Error && e.message ? e.message : '明细读取失败'); })
      .finally(() => { if (generation === generationRef.current) setLoading(false); });
    return () => {
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [open, base, target, kind, retryTick]);

  const loadMore = async () => {
    if (!open || !base || !target || loading || loadingMoreRef.current) return;
    const generation = generationRef.current;
    const nextOffset = offset + LIMIT;
    loadingMoreRef.current = true;
    setLoadingMore(true); setLoadMoreError('');
    try {
      const response = await request<CollectionDetailResponse>({
        url: '/statistics/collection/detail',
        query: collectionDetailParams(base, { feeCode: target.feeCode, natureCode: target.natureCode, kind, date: target.date }, nextOffset, LIMIT),
      });
      if (generation !== generationRef.current) return;
      if (response.available === false) {
        setLoadMoreError(response.message ? `分页明细尚未同步：${response.message}` : '分页明细尚未同步，可重试');
        return;
      }
      setRows((previous) => [...previous, ...(Array.isArray(response.rows) ? response.rows : [])]);
      setTotalCents(collectionDetailTotal(response, kind));
      setCount(response.count ?? null);
      setOffset(nextOffset);
    } catch (e) {
      if (generation === generationRef.current) setLoadMoreError(e instanceof Error && e.message ? e.message : '加载更多失败，可重试');
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const title = target ? `${target.feeName}${target.natureName || target.natureCode ? ` · ${target.natureName || target.natureCode}` : ''}` : '';
  const subtitle = target
    ? `${reportLabel}${target.date ? ` · ${target.date}` : ''}`
    : '';
  return (
    <Sheet open={open} onClose={onClose} width={1200} title={`明细 · ${title}`} subtitle={subtitle}>
      {target ? (
        <>
          <div className="ac-grant-tools stats-detail-tools">
            <div className="chips">
              {(Object.keys(KIND_LABELS) as CollectionDetailKind[]).map((item) => (
                <button key={item} type="button" className={`chip ${kind === item ? 'on' : ''}`} data-kind={item} onClick={() => setKind(item)}>
                  {KIND_LABELS[item]}
                </button>
              ))}
            </div>
            <span className="muted" data-testid="collection-detail-summary">
              共 {count ?? '—'} 笔 · 合计 <b>{totalCents == null ? '—' : fmtCents(totalCents)}</b>
            </span>
          </div>
          <div className="note2" style={{ marginBottom: 10 }}>
            <Icon name="alert" />明细合计与所点单元格同源；切换类型只改变筛选，不改变统计口径。
          </div>
          {error ? (
            <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
              <Icon name="alert" />{error}
              <button type="button" className="btn sm" data-testid="collection-detail-retry" disabled={loading} style={{ marginLeft: 8 }} onClick={() => setRetryTick((value) => value + 1)}>重试</button>
            </div>
          ) : loading ? <Loading text="读明细…" /> : !rows.length ? (
            <div className="empty">该单元格没有逐笔明细</div>
          ) : (
            <>
              <div className="t-scroll stats-detail-scroll">
                <table className="t stats-collection-detail-table" data-testid="collection-detail-table">
                  <thead>
                    <tr>
                      <th>类型</th><th>地址</th><th>业主</th><th>收费项目</th><th>房屋性质</th><th>所属年月</th>
                      <th className="num">金额</th><th>收款日期</th><th>退款日期</th><th>收款方式</th><th>收款人</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const tag = KIND_TAG[row.rowKind] ?? { text: row.rowKind, tone: 'mute' };
                      return (
                        <tr key={`${row.rowKind}-${index}-${row.address ?? ''}`} data-row-kind={row.rowKind}>
                          <td><span className={`tag ${tag.tone}`}>{tag.text}</span></td>
                          <td>{row.address || '—'}</td>
                          <td>{row.ownerName || '—'}</td>
                          <td>{row.feeName || row.feeCode || '—'}</td>
                          <td>{row.natureName || row.natureCode || '—'}</td>
                          <td>{fmtPeriod(row.period)}</td>
                          <td className="num">{fmtCents(row.amountCents)}</td>
                          <td>{row.paidDate || '—'}</td>
                          <td>{row.refundDate || '—'}</td>
                          <td>{row.paymentMethod || '—'}</td>
                          <td>{row.cashier || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {loadMoreError ? (
                <div className="note2" role="alert" data-testid="collection-detail-loadmore-error" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 8 }}>
                  <Icon name="alert" />{loadMoreError}
                  <button type="button" className="btn sm" data-testid="collection-detail-loadmore-retry" disabled={loadingMore} style={{ marginLeft: 8 }} onClick={() => void loadMore()}>重试加载更多</button>
                </div>
              ) : null}
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
