import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import {
  collectionDetailParams, fmtCents, fmtPeriod, type CollectionDetailKind, type CollectionDetailResponse,
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
  const [kind, setKind] = useState<CollectionDetailKind>('all');
  const [rows, setRows] = useState<CollectionDetailRow[]>([]);
  const [totalCents, setTotalCents] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!open || !target) return;
    setKind(target.kind ?? (target.date ? 'received' : 'all'));
  }, [open, target]);

  useEffect(() => {
    if (!open || !base || !target) return undefined;
    let cancelled = false;
    setLoading(true); setError(''); setOffset(0);
    const params = collectionDetailParams(base, { feeCode: target.feeCode, natureCode: target.natureCode, kind, date: target.date }, 0, LIMIT);
    request<CollectionDetailResponse>({ url: '/statistics/collection/detail', query: params })
      .then((response) => {
        if (cancelled) return;
        setRows(Array.isArray(response.rows) ? response.rows : []);
        setTotalCents(response.totalCents ?? null);
        setCount(response.count ?? null);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error && e.message ? e.message : '明细读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, base, target, kind]);

  const loadMore = async () => {
    if (!base || !target || loadingMore) return;
    const nextOffset = offset + LIMIT;
    setLoadingMore(true);
    try {
      const response = await request<CollectionDetailResponse>({
        url: '/statistics/collection/detail',
        query: collectionDetailParams(base, { feeCode: target.feeCode, natureCode: target.natureCode, kind, date: target.date }, nextOffset, LIMIT),
      });
      setRows((previous) => [...previous, ...(Array.isArray(response.rows) ? response.rows : [])]);
      setTotalCents(response.totalCents ?? null);
      setCount(response.count ?? null);
      setOffset(nextOffset);
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    } finally { setLoadingMore(false); }
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
              共 {count ?? rows.length} 笔 · 合计 <b>{fmtCents(totalCents)}</b>
            </span>
          </div>
          <div className="note2" style={{ marginBottom: 10 }}>
            <Icon name="alert" />明细合计与所点单元格同源；切换类型只改变筛选，不改变统计口径。
          </div>
          {error ? (
            <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{error}</div>
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
