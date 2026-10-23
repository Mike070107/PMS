import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { legacyUrl } from '@/lib/legacy';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { Btn, Card, ErrorNote, Empty, Field, Loading, Sheet, toast } from '@/components/ui';
import { dayjs, money } from '@/lib/format';

type BillStatus = 'unpaid' | 'paid' | 'refunded' | 'cancelled';

interface Bill {
  id: number;
  houseId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
  ownerName: string | null;
  feeName: string;
  period: string;
  amountCents: number;
  status: BillStatus;
  paidAt: string | null;
  paymentMethod: string | null;
  receiptNo: string | null;
  cashier: string | null;
  remark: string | null;
}

interface Summary {
  billCount: number;
  dueCents: number;
  paidCents: number;
  unpaidCents: number;
  unpaidCount: number;
}

const STATUS: Record<BillStatus, { text: string; cls: string }> = {
  unpaid: { text: '未缴', cls: 's-pend' },
  paid: { text: '已缴', cls: 's-done' },
  refunded: { text: '已退款', cls: 's-acc' },
  cancelled: { text: '已作废', cls: 's-off' },
};

const PAYMENTS = ['微信', '支付宝', '现金', '转账', '其他'];
const STATUS_FILTERS: Array<{ key: '' | BillStatus; label: string }> = [
  { key: 'unpaid', label: '未缴' },
  { key: 'paid', label: '已缴' },
  { key: 'refunded', label: '已退款' },
  { key: 'cancelled', label: '已作废' },
  { key: '', label: '全部' },
];
const PAGE_SIZE = 20;

const placeOf = (b: Bill) => `${b.communityName} ${b.buildingNo}/${b.roomNo}`;

/**
 * 账单与欠费：只管「收了多少、还欠多少、这户有哪些单」。
 * 收款走 /fees/bills/pay（和旧后台同一套账），生成账单、红冲、导出仍在旧页。
 */
export default function Bills() {
  const [rows, setRows] = useState<Bill[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | BillStatus>('unpaid');
  const [q, setQ] = useState('');
  const [pickedHouse, setPickedHouse] = useState<PickedHouse | null>(null);
  const { communities } = useAddressTree();
  const [err, setErr] = useState('');
  const [checked, setChecked] = useState<number[]>([]);

  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payment, setPayment] = useState(PAYMENTS[0]);
  const [paidAt, setPaidAt] = useState(dayjs().format('YYYY-MM-DD'));
  const [receiptNo, setReceiptNo] = useState('');
  const [remark, setRemark] = useState('');

  const query = useMemo(
    () => ({
      q: q.trim() || undefined,
      status: status || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [q, status, page],
  );

  const load = useCallback(async (kw?: string) => {
    const qq = kw === undefined ? query : { ...query, q: kw.trim() || undefined, page: 1 };
    try {
      const [list, sum] = await Promise.all([
        request<{ rows: Bill[]; total: number }>({ url: '/fees/bills', query: qq }),
        request<Summary>({ url: '/fees/bills/summary', query: qq }).catch(() => null),
      ]);
      setRows(list.rows);
      setTotal(list.total);
      setSummary(sum);
      setErr('');
      setChecked([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '账单加载失败');
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const picked = rows?.filter((b) => checked.includes(b.id) && b.status === 'unpaid') ?? [];
  const pickedAmount = picked.reduce((sum, b) => sum + b.amountCents, 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const doPay = async () => {
    if (!picked.length) return;
    setPaying(true);
    try {
      const res = await request<{ paidCount: number; receiptNo: string }>({
        method: 'POST',
        url: '/fees/bills/pay',
        data: {
          ids: picked.map((b) => b.id),
          paidAt,
          paymentMethod: payment,
          receiptNo: receiptNo || undefined,
          remark: remark || undefined,
        },
      });
      toast(`已登记收款 ${res.paidCount} 笔，收据号 ${res.receiptNo}`);
      setPayOpen(false);
      setReceiptNo('');
      setRemark('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '收款失败');
    } finally {
      setPaying(false);
    }
  };

  const toggle = (id: number) => setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (rows === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <h1>账单与欠费</h1>
          <p>按房号、账期、缴费状态查；收款在这里登记，红冲与生成账单仍在现有页面</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { window.location.href = legacyUrl('/fees'); }}>生成账单 / 红冲</button>
          {picked.length ? (
            <button className="btn p" onClick={() => setPayOpen(true)}>收款（{picked.length} 笔 · {money(pickedAmount / 100)}）</button>
          ) : null}
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div><small>当前筛选账单</small><b>{summary?.billCount ?? total}</b><em>{summary ? `${summary.unpaidCount} 笔未缴` : '—'}</em></div>
        <div><small>应收合计</small><b>{money((summary?.dueCents ?? 0) / 100)}</b><em>含已缴与未缴</em></div>
        <div><small>已收</small><b>{money((summary?.paidCents ?? 0) / 100)}</b><em>已登记收款</em></div>
        <div><small>未收</small><b style={{ color: summary?.unpaidCents ? 'var(--dang)' : undefined }}>{money((summary?.unpaidCents ?? 0) / 100)}</b><em>{summary?.unpaidCount ?? 0} 笔待收</em></div>
      </div>

      <div className="wo-bar">
        <div className="chips">
          {STATUS_FILTERS.map((item) => (
            <button key={item.key || 'all'} className={`chip ${status === item.key ? 'on' : ''}`}
              onClick={() => { setStatus(item.key); setPage(1); }}>{item.label}</button>
          ))}
        </div>
        <div style={{ width: 420, marginLeft: 'auto' }}>
          <HousePicker
            communities={communities}
            value={pickedHouse}
            placeholder="输入 228/6/502 或点选 小区→楼栋→室号，也可搜业主/收据号"
            onPick={(p) => { const key = `${p.buildingNo}/${p.roomNo}`; setPickedHouse(p); setQ(key); setPage(1); void load(key); }}
            onTextChange={(text) => setQ(text)}
            onClear={() => { setPickedHouse(null); setQ(''); setPage(1); void load(''); }}
          />
        </div>
        <Btn onClick={() => { setPage(1); void load(); }}>查询</Btn>
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 34 }} />
              <th>房号</th><th>业主</th><th>收费项目</th><th>账期</th>
              <th style={{ textAlign: 'right' }}>金额</th>
              <th>状态</th><th>缴费</th><th>收据号</th>
            </tr>
          </thead>
          <tbody>
            {rows?.length ? rows.map((b) => (
              <tr key={b.id} className="row">
                <td>
                  <input type="checkbox" disabled={b.status !== 'unpaid'} checked={checked.includes(b.id)} onChange={() => toggle(b.id)} />
                </td>
                <td><b>{placeOf(b)}</b></td>
                <td>{b.ownerName || <span className="muted">—</span>}</td>
                <td className="sub">{b.feeName}</td>
                <td className="sub">{b.period}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(b.amountCents / 100)}</td>
                <td><span className={`pill ${STATUS[b.status]?.cls || 's-off'}`}>{STATUS[b.status]?.text || b.status}</span></td>
                <td className="sub">{b.paidAt ? `${dayjs(b.paidAt).format('MM-DD')}${b.paymentMethod ? ` · ${b.paymentMethod}` : ''}` : '—'}</td>
                <td className="muted">{b.receiptNo || '—'}</td>
              </tr>
            )) : <tr><td colSpan={9} className="empty">没有符合条件的账单</td></tr>}
          </tbody>
        </table>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <span className="muted">共 {total} 笔 · 第 {page} / {pages} 页</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Btn>
          <Btn size="sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>下一页</Btn>
        </div>
      </div>

      <div className="note" style={{ marginTop: 14 }}>
        这里登记收款走的是同一套账（/fees/bills/pay），收据号留空由系统生成；
        退款走红冲，原收据保留。生成账单、红冲、导出报表仍在现有物业费页。
      </div>

      <Sheet open={payOpen} onClose={() => setPayOpen(false)} title="登记收款"
        subtitle={picked.length ? `${picked.length} 笔 · ${money(pickedAmount / 100)}` : ''}>
        {picked.length ? (
          <>
            <div className="sec-t">本次收款明细</div>
            <table className="t" style={{ marginBottom: 16 }}>
              <thead><tr><th>房号</th><th>项目</th><th>账期</th><th style={{ textAlign: 'right' }}>金额</th></tr></thead>
              <tbody>
                {picked.map((b) => (
                  <tr key={b.id}>
                    <td>{placeOf(b)}</td>
                    <td className="sub">{b.feeName}</td>
                    <td className="sub">{b.period}</td>
                    <td style={{ textAlign: 'right' }}>{money(b.amountCents / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Field label="收款方式">
              <div className="chips">
                {PAYMENTS.map((p) => (
                  <button key={p} className={`chip ${payment === p ? 'on' : ''}`} onClick={() => setPayment(p)}>{p}</button>
                ))}
              </div>
            </Field>
            <Field label="收款日期">
              <input className="in" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </Field>
            <Field label="收据号（留空自动生成）">
              <input className="in" value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} />
            </Field>
            <Field label="备注（选填）">
              <input className="in" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </Field>

            <Btn kind="p" size="lg" disabled={paying} onClick={() => void doPay()}>
              {paying ? '提交中…' : `确认收款 ${money(pickedAmount / 100)}`}
            </Btn>
          </>
        ) : <Empty>没有选中可收款的账单</Empty>}
      </Sheet>
    </>
  );
}
