import { useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { money, payLabel } from '@/lib/format';
import './mis-remarks.css';

export interface PaidRow {
  id: string; feeName: string | null; feeCode: string; period: string; amountCents: number;
  paidAt: string | null; receiptNo: string | null; invoiceNo: string | null; paymentMethod: string | null; cashier: string | null; remark?: string | null;
}

/** 一户的 MIS 已缴记录：物业费、泊位费两个页签共用一次查询（按房屋缓存） */
const cache = new Map<number, Promise<PaidRow[]>>();
export function loadPaid(houseId: number, force = false): Promise<PaidRow[]> {
  if (force) cache.delete(houseId);
  let p = cache.get(houseId);
  if (!p) {
    p = request<{ rows: PaidRow[] }>({ url: '/fees/mis/bills', query: { houseId, status: 'paid', page: 1, pageSize: 500 }, timeout: 25000 })
      .then((r) => r.rows ?? []);
    p.catch(() => cache.delete(houseId));
    cache.set(houseId, p);
  }
  return p;
}

/**
 * 历史缴费记录（默认折叠，展开才查 MIS）。
 * 作用：「没有待缴」时，前台能当场看到是哪天、哪张收据缴的，而不是猜是没查到还是真缴过了。
 */
export default function PaidHistory({ houseId, label, match }: { houseId: number; label: string; match: (feeName: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PaidRow[] | null>(null);
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);

  const load = (force = false) => {
    setRows(null); setErr('');
    loadPaid(houseId, force)
      .then((r) => setRows(r.filter((x) => match(x.feeName || x.feeCode)).sort((a, b) => (b.period || '').localeCompare(a.period || '') || (b.paidAt || '').localeCompare(a.paidAt || ''))))
      .catch((e) => setErr(e instanceof Error ? e.message : 'MIS 查询失败'));
  };
  const toggle = () => { const n = !open; setOpen(n); if (n && rows === null && !err) load(); };
  const shown = rows ? (all ? rows : rows.slice(0, 24)) : [];
  const total = rows?.reduce((s, r) => s + r.amountCents, 0) ?? 0;

  return (
    <div className="card mis-paid-history" style={{ marginTop: 14, overflow: 'hidden' }}>
      <button className="hist-hd" onClick={toggle}>
        <Icon name="chev" size={16} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: '.15s' }} />
        <b>历史缴费记录</b>
        <span className="muted" style={{ fontSize: 13.5 }}>
          {!open ? '点开查询 MIS 已缴' : rows === null && !err ? '查询中…' : err ? '查询未完成' : rows!.length ? `${rows!.length} 笔 · 共 ${money(total / 100)}` : `没有${label}缴费记录`}
        </span>
        {open && (rows || err) ? <span className="btn g sm" style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); load(true); }}><Icon name="refresh" size={14} />重查</span> : null}
      </button>
      {open ? (
        rows === null && !err ? <div className="empty" style={{ padding: 20 }}>正在查询 MIS 已缴记录…</div>
          : err ? <div style={{ padding: '14px 16px', color: 'var(--dang)' }}>MIS 查询未完成：{err}<div className="muted" style={{ fontSize: 13 }}>不代表没有缴费记录，请点「重查」</div></div>
            : !rows!.length ? <div className="muted" style={{ padding: '14px 16px' }}>已查询 MIS：这一户没有{label}的缴费记录</div>
              : (
                <>
                  <div className="mis-paid-scroll">
                  <table className="tbl">
                    <thead><tr><th>账期</th><th>项目</th><th style={{ textAlign: 'right' }}>金额</th><th>缴费日期</th><th>收据号</th><th>收款</th><th>备注</th></tr></thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.id} style={{ cursor: 'default' }}>
                          <td><b>{r.period || '—'}</b></td>
                          <td>{r.feeName || r.feeCode}</td>
                          <td style={{ textAlign: 'right' }} className="money">{money(r.amountCents / 100)}</td>
                          <td>{r.paidAt ? r.paidAt.slice(0, 10) : '—'}</td>
                          <td>{r.receiptNo || r.invoiceNo || '—'}</td>
                          <td className="muted">{[payLabel(r.paymentMethod), r.cashier].filter((x) => x && x !== '—').join(' · ') || '—'}</td>
                          <td><span className="mis-remark-value">{r.remark?.trim() ? r.remark : '—'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  {rows!.length > 24 && !all ? <button className="btn g sm" style={{ margin: '8px 12px 12px' }} onClick={() => setAll(true)}>显示全部 {rows!.length} 笔</button> : null}
                </>
              )
      ) : null}
    </div>
  );
}
