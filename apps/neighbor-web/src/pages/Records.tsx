import { useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { legacyUrl } from '@/lib/legacy';
import { dayjs, money } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';

interface Txn {
  id: number; txnNo: string; serviceType: string; status: string; amountCents: number;
  paymentMethod: string | null; createdAt: string; externalSyncStatus?: string; invoiceStatus?: string;
  plateNo?: string | null; quantity?: number;
}

const LABEL: Record<string, string> = { parking_monthly: '停车月租', access_card: '门禁卡' };
const svcIcon = (s: string): IconName => (s === 'parking_monthly' ? 'car' : s === 'access_card' ? 'key' : 'cash');
type Filter = '' | 'parking_monthly' | 'access_card' | 'free' | 'refunded';

/**
 * 办理记录：前台停车/门禁收款单与业务行（/business/transactions，真实流水）。
 * 物业费收款在「账单与待缴」另一套账；退款（红冲）与收据打印走旧收费页，这里给入口。
 */
export default function Records() {
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [q, setQ] = useState('');

  useEffect(() => {
    request<Txn[]>({ url: '/business/transactions' }).then(setTxns).catch(() => setTxns([]));
  }, []);

  const rows = useMemo(() => {
    let list = txns ?? [];
    if (filter === 'parking_monthly' || filter === 'access_card') list = list.filter((t) => t.serviceType === filter);
    else if (filter === 'refunded') list = list.filter((t) => t.status === 'refunded');
    else if (filter === 'free') list = list.filter((t) => t.amountCents === 0);
    const kw = q.trim();
    if (kw) list = list.filter((t) => (t.txnNo || '').includes(kw) || (t.plateNo || '').includes(kw));
    return list;
  }, [txns, filter, q]);

  const sum = rows.filter((t) => t.status !== 'refunded').reduce((s, t) => s + t.amountCents, 0);

  if (txns === null) return <Loading />;

  const FILTERS: Array<[Filter, string]> = [['', '全部'], ['parking_monthly', '停车'], ['access_card', '门禁卡'], ['free', '免费'], ['refunded', '已退款']];

  const syncTag = (t: Txn) => {
    const s = t.externalSyncStatus;
    if (s === 'completed' || s === 'synced') return <span className="tag ok"><Icon name="check" />已核验</span>;
    if (s === 'failed') return <span className="tag dang"><Icon name="alert" />失败</span>;
    if (s === 'manual') return <span className="tag dang"><Icon name="alert" />需人工</span>;
    if (s === 'dry_run') return <span className="tag mute"><Icon name="check" />演练未写入</span>;
    if (s === 'queued' || s === 'running' || s === 'retry') return <span className="tag acc"><Icon name="refresh" />同步中</span>;
    if (s === 'mocked') return <span className="tag mute"><Icon name="clock" />未接自动同步</span>;
    return <span className="tag warn"><Icon name="clock" />待核验</span>;
  };

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>办理记录</h1><p>停车 / 门禁收款单与业务行 · 近 100 笔</p></div>
        <div className="act"><button className="btn" onClick={() => { window.location.href = `${import.meta.env.BASE_URL}fees`; }}><Icon name="receipt" size={18} />物业费流水 / 红冲</button></div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="chips">
          {FILTERS.map(([k, n]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{n}</button>)}
        </div>
        <input className="in" style={{ width: 280, marginLeft: 'auto' }} placeholder="搜收据号 / 车牌" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="tag acc">合计 {money(sum / 100)}</span>
      </div>

      <div className="card" style={{ overflow: 'hidden', marginTop: 4 }}>
        <div className="rowList">
          {rows.length === 0 ? <div className="empty" style={{ padding: 40 }}>没有匹配的记录</div>
            : rows.map((t) => (
              <div key={t.id} className="lrow">
                <div className={`li ic ${t.status === 'refunded' ? 'red' : t.amountCents === 0 ? 'blue' : 'green'}`}><Icon name={svcIcon(t.serviceType)} /></div>
                <div className="lt">
                  {/* 第一行给用户看的：办了什么、对着谁；流水号降级成小字，只用于对账 */}
                  <b>
                    {LABEL[t.serviceType] || t.serviceType}
                    {t.plateNo ? <span style={{ marginLeft: 8 }}>{t.plateNo}</span> : null}
                    {t.amountCents === 0 ? <span className="tag mute" style={{ marginLeft: 8, height: 20 }}>免费</span> : null}
                  </b>
                  <small>{dayjs(t.createdAt).format('MM-DD HH:mm')} · {t.paymentMethod || '—'} · 单号 {t.txnNo.slice(-6)}</small>
                </div>
                {syncTag(t)}
                <b className="money" style={{ minWidth: 88, textAlign: 'right', color: t.status === 'refunded' ? 'var(--dang)' : undefined }}>{t.status === 'refunded' ? '−' : ''}{money(t.amountCents / 100)}</b>
              </div>
            ))}
        </div>
      </div>

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />「待核验」= 收款已登记、外部系统（停车/MIS）尚未回读确认，在「待处理」里跟踪；退款与收据套打走旧收费页。</div>
    </>
  );
}
