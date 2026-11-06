import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useState } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { money } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';
import { FeeTrendChart, FeeBreakdownChart } from '@/legacy/components/FeeReportCharts';
import './erp-reference-pages.css';

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
const fmtD = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const firstOfMonth = () => fmtD(new Date()).slice(0, 8) + '01';
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return fmtD(d); };

function Growth({ v }: { v: number }) {
  if (!isFinite(v) || v === 0) return <span className="muted" style={{ fontSize: 16 }}>持平</span>;
  const up = v > 0;
  return <span style={{ fontSize: 16, color: up ? 'var(--ok)' : 'var(--dang)' }}>{up ? '▲' : '▼'} {Math.abs(Math.round(v * 100))}%</span>;
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
  const [revision,setRevision]=useState(0);
  const scope=JSON.stringify([session.generation,session.user?.id,session.actingTenant?.id,session.access?.scopeAll,session.access?.communityIds]);

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const load = () => {
    let alive=true;
    setData(null); setErr('');
    request<Report>({ url: '/fees/reports/summary', query: { from, to, communityId: communityId || undefined } })
      .then(r=>{if(alive)setData(r)}).catch(()=>{if(alive)setErr('报表读取失败，条件保留，请重试')});
    return()=>{alive=false};
  };
  useEffect(load, [from, to, communityId,scope,revision]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };


  const kpis: Array<{ icon: IconName; tone: string; label: string; val: string; growth?: number }> = data ? [
    { icon: 'cash', tone: 'green', label: '净收款', val: money(data.totals.netCents / 100), growth: data.growth.netCents },
    { icon: 'receipt', tone: 'blue', label: '收据数', val: String(data.totals.receiptCount), growth: data.growth.receiptCount },
    { icon: 'home', tone: 'blue', label: '收费户数', val: String(data.totals.houseCount), growth: data.growth.houseCount },
    { icon: 'refresh', tone: 'amber', label: '退款(红冲)', val: money(data.totals.refundedCents / 100) },
  ] : [];

  const Bars = ({ title, icon, rows }: { title: string; icon: IconName; rows: Array<{ key: string; name: string; amountCents: number; count: number; share: number }> }) => (
    <section className="card erp-report-breakdown">
      <h2 className="secTitle"><Icon name={icon} size={18} />{title}</h2>
      <FeeBreakdownChart loading={false} rows={rows.map(r => ({ ...r, share: Number.isFinite(r.share) ? Math.round(r.share * 100) : null }))} />
    </section>
  );

  return (
    <div className="erp-reports">
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

      {err ? <div role="alert" className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginTop: 4 }}><Icon name="alert" />{err}<button className="btn" onClick={()=>setRevision(n=>n+1)}>重试报表</button></div> : null}

      {data === null && !err ? <Loading /> : data ? (
        <>
          <div className="erp-report-kpis" style={{ marginTop: 4 }}>
            {kpis.map((k) => (
              <div key={k.label} className="stat">
                <div className={`ic ${k.tone}`} style={{ width: 44, height: 44 }}><Icon name={k.icon} /></div>
                <div className="v" style={{ fontSize: 22 }}>{k.val}</div>
                <div className="k">{k.label}{k.growth !== undefined ? <> · <Growth v={k.growth} /></> : null}</div>
              </div>
            ))}
          </div>

          <section className="card erp-report-trend" data-testid="reports-trend-chart" role="region" aria-label="收款趋势，金额单位元，含红冲负数">
            <h2 className="secTitle"><Icon name="chart" size={18} />收款趋势</h2>
            <FeeTrendChart loading={false} rows={data.trend.map(t => ({ bucket: t.label || t.bucket || t.day || '未标注日期', amountCents: t.amountCents, count: t.count }))} label={bucket => bucket} />
            <details><summary>查看趋势明细 · {data.trend.length} 个日期</summary>
              <div className="erp-report-table"><table><thead><tr><th>日期</th><th className="num">净收款（元）</th><th className="num">笔数</th></tr></thead><tbody>
                {data.trend.map((t, i) => <tr key={i}><td>{t.label || t.bucket || t.day || '未标注日期'}</td><td className="num">{money(t.amountCents / 100)}</td><td className="num">{t.count}</td></tr>)}
              </tbody></table></div>
            </details>
          </section>
          <div className="erp-report-breakdowns">

          <Bars title="按费项" icon="receipt" rows={data.byFee.map((r) => ({ key: r.feeCode, name: r.feeName, amountCents: r.amountCents, count: r.count, share: r.share }))} />
          <Bars title="按收款方式" icon="wallet" rows={data.byMethod.map((r) => ({ key: r.method || 'null', name: PM_LABEL[r.method || ''] || r.method || '未知', amountCents: r.amountCents, count: r.count, share: r.share }))} />
          {data.byCommunity.length > 1 ? <Bars title="按小区" icon="building" rows={data.byCommunity.map((r) => ({ key: String(r.communityId), name: r.communityName || '未分小区', amountCents: r.amountCents, count: r.count, share: r.share }))} /> : null}
          <Bars title="按收费员" icon="users" rows={data.byCashier.map((r) => ({ key: r.cashier || 'null', name: r.cashier || '未记名', amountCents: r.amountCents, count: r.count, share: r.share }))} />
          </div>
        </>
      ) : null}

      <div className="note2"><Icon name="alert" />口径：按实收时间，红冲计负、当天收完又红冲的互相抵消；与 MIS 账期报表不是一套数，MIS 对账仍在旧报表页。</div>
    </div>
  );
}
