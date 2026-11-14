import { formatBeijingDateTime } from '@pms/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import { dayjs, money, payLabel } from '@/lib/format';
import FeeIcon from '@/components/FeeIcon';
import ToneIcon from '@/components/ToneIcon';
import MisFeeLedger from './MisFeeLedger';

interface BillRow {
  id: number; receiptNo: string | null; originalReceiptNo: string | null; reversalReceiptNo: string | null;
  communityName: string | null; lane: string | null; buildingNo: string | null; roomNo: string | null;
  ownerName: string | null; feeName: string | null; feeCode: string | null; period: string | null;
  amountCents: number; quantity: string | number | null; unit: string | null; unitPriceCents: number | null;
  status: string; paidAt: string | null; paymentMethod: string | null; cashier: string | null;
  remark: string | null; vehiclePlate: string | null; serviceFrom: string | null; serviceTo: string | null;
}

const STATUS: Record<string, { text: string; tone: string }> = {
  paid: { text: '已收', tone: 'ok' },
  unpaid: { text: '未缴', tone: 'warn' },
  refunded: { text: '已红冲', tone: 'dang' },
  cancelled: { text: '已作废', tone: 'mute' },
};
const statusOf = (r: BillRow) => {
  if (r.originalReceiptNo) return { text: '红冲单', tone: 'dang' };
  if (!r.receiptNo && r.status === 'paid') return { text: '已收', tone: 'ok' };
  return STATUS[r.status] ?? { text: r.status || '—', tone: 'mute' };
};
const place = (r: BillRow) => [r.communityName, r.lane ? `${r.lane}弄` : '', r.buildingNo ? `${r.buildingNo}号` : '', r.roomNo || ''].filter(Boolean).join(' ');
const PAGE = 30;

/**
 * 收费流水：按实收时间列出物业费/泊位费/停车/门禁的每一笔，点开看详情，
 * 可补打收据（进日志可追溯）与红冲（原单号保留，不物理删除）。
 * 数据：GET /fees/bills；补打/红冲走 /fees/cashier/receipts/:receiptNo/*。
 */
export default function Fees(){
 const [source,setSource]=useState<'mis'|'local'>('mis');
 return <><div className="chips" style={{display:'flex',gap:8,flexWrap:'nowrap',overflowX:'auto',marginBottom:14}}><button className={`chip ${source==='mis'?'on':''}`} onClick={()=>setSource('mis')}>MIS实收原账</button><button className={`chip ${source==='local'?'on':''}`} onClick={()=>setSource('local')}>本系统公寓流水</button></div>{source==='mis'?<MisFeeLedger/>:<LocalFees/>}</>;
}
function LocalFees() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'paid' | 'unpaid' | 'refunded'>('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [active, setActive] = useState<BillRow | null>(null);

  const load = useCallback(async () => {
    setRows(null); setErr('');
    try {
      const r = await request<{ rows: BillRow[]; total: number }>({
        url: '/fees/bills',
        query: { q: q.trim() || undefined, status: status || undefined, page, pageSize: PAGE },
      });
      setRows(r?.rows ?? []); setTotal(r?.total ?? 0);
    } catch (e) {
      setRows([]); setErr(e instanceof Error ? e.message : '加载失败');
    }
  }, [q, status, page]);

  useEffect(() => { void load(); }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const collected = useMemo(() => (rows ?? []).filter((r) => r.status === 'paid' && !r.originalReceiptNo).reduce((s, r) => s + r.amountCents, 0), [rows]);

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="fees" /><h1 style={{ fontSize: 22 }}>收费流水</h1></div>
          <p>按实收时间列出每一笔收费；点开可补打收据、红冲</p>
        </div>
        <div className="act">
          <span className="tag mute">本页实收 {money(collected / 100)} · 共 {total} 笔</span>
        </div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips" style={{ display: 'flex', gap: 6 }}>
          {([['', '全部'], ['paid', '已收'], ['unpaid', '未缴'], ['refunded', '已红冲']] as const).map(([k, t]) => (
            <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{t}</button>
          ))}
        </div>
        <input className="in" style={{ width: 260 }} value={q} placeholder="房号 / 业主 / 收据号，回车"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); void load(); } }} />
        <button className="btn" onClick={() => { setPage(1); void load(); }}><Icon name="search" size={18} />查询</button>
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 8 }}><Icon name="alert" />{err}</div> : null}

      {rows === null ? <Loading /> : rows.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 6 }}><span className="muted">没有符合条件的收费记录</span></div>
      ) : (
        <div className="card t-scroll" style={{ marginTop: 6 }}>
          <table className="t" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th style={{ width: 120 }}>收据号</th><th style={{ width: 130 }}>时间</th><th>住户</th>
                <th>收费项目</th><th style={{ width: 100, textAlign: 'right' }}>金额</th>
                <th style={{ width: 96 }}>收款方式</th><th style={{ width: 90 }}>状态</th><th style={{ width: 70 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = statusOf(r);
                return (
                  <tr key={r.id} onClick={() => setActive(r)} style={{ cursor: 'pointer' }}>
                    <td className="nw"><b>{r.receiptNo || '—'}</b>{r.originalReceiptNo ? <div className="sub2">原 {r.originalReceiptNo}</div> : null}</td>
                    <td className="nw">{r.paidAt ? formatBeijingDateTime(r.paidAt, 'MM-DD HH:mm') : '—'}</td>
                    <td><b>{place(r) || '—'}</b><div className="sub2">{r.ownerName || ''}</div></td>
                    <td><span className="feeCell"><FeeIcon name={r.feeName || r.feeCode} size={26} />{r.feeName || r.feeCode || '—'}</span>{r.period ? <span className="muted"> · {r.period}</span> : null}{r.vehiclePlate ? <span className="muted"> · {r.vehiclePlate}</span> : null}</td>
                    <td className="nw" style={{ textAlign: 'right' }}><b>{money(r.amountCents / 100)}</b></td>
                    <td className="nw">{payLabel(r.paymentMethod)}</td>
                    <td className="nw"><span className={`tag ${st.tone}`}>{st.text}</span></td>
                    <td className="nw"><button className="btn g sm" onClick={(e) => { e.stopPropagation(); setActive(r); }}>详情</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', marginTop: 16 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span className="muted">第 {page} / {pages} 页</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      ) : null}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />红冲不删除原单：原收据号保留、生成负数红冲单，财务报表按实收口径统计。补打会记入日志，谁补打了哪张票可追。</div>

      {active ? <BillSheet row={active} onClose={() => setActive(null)} onChanged={() => { setActive(null); void load(); }} /> : null}
    </>
  );
}

function BillSheet({ row, onClose, onChanged }: { row: BillRow; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const st = statusOf(row);
  const canRefund = row.status === 'paid' && !!row.receiptNo && !row.originalReceiptNo;

  const reprint = async () => {
    if (!row.receiptNo) return;
    setBusy('reprint');
    try {
      await request({ method: 'POST', url: `/fees/cashier/receipts/${encodeURIComponent(row.receiptNo)}/reprint` });
      toast('已记录补打，可在日志中追溯');
    } catch (e) { toast(e instanceof Error ? e.message : '补打失败'); }
    finally { setBusy(''); }
  };

  const refund = async () => {
    if (!row.receiptNo) return;
    setBusy('refund');
    try {
      await request({ method: 'POST', url: `/fees/cashier/receipts/${encodeURIComponent(row.receiptNo)}/refund`, data: { reason: reason.trim() || undefined } });
      toast('已红冲');
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : '红冲失败'); setBusy(''); }
  };

  return (
    <Sheet open onClose={onClose} width={540} title={`收据 ${row.receiptNo || '—'}`} subtitle={st.text}>
      <div style={{ padding: '4px 2px' }}>
        <dl className="kv" style={{ margin: '0 0 14px' }}>
          <dt>住户</dt><dd>{place(row) || '—'} {row.ownerName ? `· ${row.ownerName}` : ''}</dd>
          <dt>收费项目</dt><dd>{row.feeName || row.feeCode || '—'}{row.period ? ` · ${row.period}` : ''}</dd>
          {row.vehiclePlate ? <><dt>车牌</dt><dd>{row.vehiclePlate}</dd></> : null}
          <dt>金额</dt><dd><b>{money(row.amountCents / 100)}</b>{row.quantity ? `（${row.quantity}${row.unit || ''}）` : ''}</dd>
          <dt>收款方式</dt><dd>{payLabel(row.paymentMethod)}</dd>
          <dt>收款时间</dt><dd>{row.paidAt ? formatBeijingDateTime(row.paidAt, 'YYYY-MM-DD HH:mm') : '—'}</dd>
          <dt>收费员</dt><dd>{row.cashier || '—'}</dd>
          {row.serviceFrom || row.serviceTo ? <><dt>服务期</dt><dd>{row.serviceFrom || '—'} ~ {row.serviceTo || '—'}</dd></> : null}
          {row.originalReceiptNo ? <><dt>原收据</dt><dd>{row.originalReceiptNo}</dd></> : null}
          {row.reversalReceiptNo ? <><dt>红冲单</dt><dd>{row.reversalReceiptNo}</dd></> : null}
          {row.remark ? <><dt>备注</dt><dd>{row.remark}</dd></> : null}
        </dl>

        {ask ? (
          <>
            <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 10 }}>
              红冲会把这一笔标记为已红冲并生成负数单，原收据号保留，不能撤销。
            </div>
            <input className="in" style={{ width: '100%', marginBottom: 10 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="红冲原因（选填，建议写清）" />
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn d" style={{ flex: 1 }} disabled={busy === 'refund'} onClick={() => void refund()}>{busy === 'refund' ? '处理中…' : '确认红冲'}</button>
              <button className="btn" onClick={() => setAsk(false)}>取消</button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn p" style={{ flex: 1 }} disabled={!row.receiptNo || busy === 'reprint'} onClick={() => void reprint()}>
              <Icon name="print" size={16} />{busy === 'reprint' ? '记录中…' : '补打收据'}
            </button>
            {canRefund ? <button className="btn g" disabled={busy === 'refund'} onClick={() => setAsk(true)}><Icon name="receipt" size={16} />红冲</button> : null}
          </div>
        )}
      </div>
    </Sheet>
  );
}
