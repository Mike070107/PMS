import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useState } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { money } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';

interface Breakdown { amountCents: number; count: number; share: number }
interface MethodRow extends Breakdown { method: string | null }
interface FeeRow extends Breakdown { feeCode: string; feeName: string }
interface CommunityRow extends Breakdown { communityId: number | null; communityName: string | null }
interface CashierRow extends Breakdown { cashier: string | null }
interface TrendRow { day?: string; bucket?: string; label?: string; amountCents: number; count: number }
interface Totals { netCents: number; chargedCents: number; refundedCents: number; receiptCount: number; houseCount: number; itemCount: number }
interface Report {
  range: { from: string; to: string; granularity: string }; totals: Totals; previous: Totals;
  growth: { netCents: number; receiptCount: number; houseCount: number };
  trend: TrendRow[]; byMethod: MethodRow[]; byFee: FeeRow[]; byCommunity: CommunityRow[]; byCashier: CashierRow[];
}

const PM_LABEL: Record<string, string> = { cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行', pos: '刷卡', transfer: '转账', other: '其他' };
const fmtD = (d: Date) => d.toISOString().slice(0, 10);
const firstOfMonth = () => { const d = new Date(); return fmtD(new Date(d.getFullYear(), d.getMonth(), 1)); };
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return fmtD(d); };

function Growth({ v }: { v: number }) {
  if (!isFinite(v) || v === 0) return <span className="muted" style={{ fontSize: 12 }}>持平</span>;
  const up = v > 0;
  return <span style={{ fontSize: 12, color: up ? 'var(--ok)' : 'var(--dang)' }}>{up ? '▲' : '▼'} {Math.abs(Math.round(v * 100))}%</span>;
}

/** 收费报表（beta 新建，只读）：按实收口径统计本系统收款，不依赖 MIS 连通。 */
export default function Reports() {
  const session = useSession();
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(fmtD(new Date()));
  const [communityId, setCommunityId] = useState<number | 0>(0);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const load = () => {
    setData(null); setErr('');
    request<Report>({ url: '/fees/reports/summary', query: { from, to, communityId: communityId || undefined } })
      .then(setData).catch((e) => setErr(e instanceof Error ? e.message : '报表加载失败'));
  };
  useEffect(load, [from, to, communityId]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
  const maxTrend = useMemo(() => Math.max(1, ...(data?.trend ?? []).map((t) => t.amountCents)), [data]);

  const kpis: Array<{ icon: IconName; tone: string; label: string; val: string; growth?: number }> = data ? [
    { icon: 'cash', tone: 'green', label: '净收款', val: money(data.totals.netCents / 100), growth: data.growth.netCents },
    { icon: 'receipt', tone: 'blue', label: '收据数', val: String(data.totals.receiptCount), growth: data.growth.receiptCount },
    { icon: 'home', tone: 'blue', label: '收费户数', val: String(data.totals.houseCount), growth: data.growth.houseCount },
    { icon: 'refresh', tone: 'amber', label: '退款(红冲)', val: money(data.totals.refundedCents / 100) },
  ] : [];

  const Bars = ({ title, icon, rows }: { title: string; icon: IconName; rows: Array<{ key: string; name: string; amountCents: number; count: number; share: number }> }) => (
    <div style={{ marginBottom: 18 }}>
      <div className="secTitle"><Icon name={icon} size={18} />{title}</div>
      {rows.length === 0 ? <div className="card" style={{ padding: 20, textAlign: 'center' }}><span className="muted">区间内无数据</span></div> : (
        <div className="card" style={{ padding: '14px 16px' }}>
          {rows.map((r) => (
            <div key={r.key} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
                <span>{r.name} <span className="muted" style={{ fontSize: 12 }}>· {r.count} 笔</span></span>
                <b className="money">{money(r.amountCents / 100)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{Math.round(r.share * 100)}%</span></b>
              </div>
              <div style={{ height: 7, background: 'var(--sunken)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(2, r.share * 100)}%`, height: '100%', background: 'var(--acc)' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>收费报表</h1><p>按实收时间统计 · 本系统收款口径（不依赖 MIS）</p></div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <DateInput className="in" type="date" style={{ width: 150 }} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span className="muted">至</span>
        <DateInput className="in" type="date" style={{ width: 150 }} value={to} min={from} max={fmtD(new Date())} onChange={(e) => setTo(e.target.value)} />
        <div className="chips">
          <button className="chip" onClick={() => preset(daysAgo(6), fmtD(new Date()))}>近7天</button>
          <button className="chip" onClick={() => preset(daysAgo(29), fmtD(new Date()))}>近30天</button>
          <button className="chip" onClick={() => preset(firstOfMonth(), fmtD(new Date()))}>本月</button>
        </div>
        <select className="in" style={{ width: 180, marginLeft: 'auto' }} value={communityId} onChange={(e) => setCommunityId(Number(e.target.value))}>
          <option value={0}>全部小区</option>
          {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginTop: 4 }}><Icon name="alert" />{err}</div> : null}

      {data === null && !err ? <Loading /> : data ? (
        <>
          <div className="pendGrid" style={{ marginTop: 4 }}>
            {kpis.map((k) => (
              <div key={k.label} className="stat">
                <div className={`ic ${k.tone}`} style={{ width: 44, height: 44 }}><Icon name={k.icon} /></div>
                <div className="v" style={{ fontSize: 22 }}>{k.val}</div>
                <div className="k">{k.label}{k.growth !== undefined ? <> · <Growth v={k.growth} /></> : null}</div>
              </div>
            ))}
          </div>

          <div className="secTitle"><Icon name="chart" size={18} />收款趋势</div>
          <div className="card" style={{ padding: '16px 16px 8px', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
              {data.trend.map((t, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} title={`${t.label || t.bucket || t.day}：${money(t.amountCents / 100)}`}>
                  <div style={{ width: '70%', height: `${Math.max(2, (t.amountCents / maxTrend) * 100)}%`, background: 'var(--acc)', borderRadius: '3px 3px 0 0', minHeight: 2 }} />
                  <span className="muted" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{(t.label || t.bucket || t.day || '').slice(5)}</span>
                </div>
              ))}
            </div>
          </div>

          <Bars title="按费项" icon="receipt" rows={data.byFee.map((r) => ({ key: r.feeCode, name: r.feeName, amountCents: r.amountCents, count: r.count, share: r.share }))} />
          <Bars title="按收款方式" icon="wallet" rows={data.byMethod.map((r) => ({ key: r.method || 'null', name: PM_LABEL[r.method || ''] || r.method || '未知', amountCents: r.amountCents, count: r.count, share: r.share }))} />
          {data.byCommunity.length > 1 ? <Bars title="按小区" icon="building" rows={data.byCommunity.map((r) => ({ key: String(r.communityId), name: r.communityName || '未分小区', amountCents: r.amountCents, count: r.count, share: r.share }))} /> : null}
          <Bars title="按收费员" icon="users" rows={data.byCashier.map((r) => ({ key: r.cashier || 'null', name: r.cashier || '未记名', amountCents: r.amountCents, count: r.count, share: r.share }))} />
        </>
      ) : null}

      <div className="note2"><Icon name="alert" />口径：按实收时间，红冲计负、当天收完又红冲的互相抵消；与 MIS 账期报表不是一套数，MIS 对账仍在旧报表页。</div>
    </>
  );
}
