import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { request } from '@pms/api-client';
import { cents, chinaDate } from '@/lib/residential-bills';
import { firstAllowedPath } from '@/lib/page-access';
import { useSession } from '@/lib/auth';
import '@/styles/screen.css';

type Query = Record<string, string | number | boolean | undefined>;
type Summary = { receivableCents: number; paidCents: number; unpaidCents: number; unpaidHouses: number; adjustmentCount?: number };
type Dashboard = { summary: Summary; queriedAt?: string };
type Trend = { rows: { day: string; netCents: number; chargedCents: number; refundedCents: number }[] };
type AgingBuckets = Record<'0-30' | '31-60' | '61-90' | '90+', { count: number; amountCents: number }>;
type Aging = { buckets: AgingBuckets; total: number; amountCents: number; truncated: boolean; scanned: number };
type Houses = { aging?: Aging };
type Batch = { id: number; createdAt: string; purpose: 'print' | 'sms'; houseCount: number; amountCents: string };
type Batches = { rows: Batch[]; total: number };
type Effect = { summary: { notifiedCents: number; recoveredCents: number; recoveryRate: number; clearedHouseholds: number }; invalidPaidDateCount?: number };
type SmsStats = Record<string, unknown>;

const REFRESH_MS = 60_000;
const AGING_KEYS = ['0-30', '31-60', '61-90', '90+'] as const;
const AGING_LABELS: Record<(typeof AGING_KEYS)[number], string> = { '0-30': '≤30 天', '31-60': '31-60 天', '61-90': '61-90 天', '90+': '90+ 天' };

function message(e: unknown) {
  const text = e instanceof Error ? e.message : '';
  return /[\u4e00-\u9fff]/.test(text) ? text : '接口读取失败，稍后重试';
}
function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
/** 大屏横轴/金额缩写：≥1 万元用「万」，避免 6 个月标签挤在一起。 */
function compact(centsValue: number) {
  if (!Number.isFinite(centsValue)) return '¥0';
  if (Math.abs(centsValue) >= 1_000_000) return '¥' + (centsValue / 1_000_000).toFixed(1) + '万';
  return '¥' + cents(centsValue);
}
function monthLabel(month: string) {
  return Number(month.slice(5)) + ' 月';
}

/** 每 60 秒取一次；页面隐藏（切换标签页/最小化）时暂停，回来立即补一次。 */
function useLive<T>(url: string, query: Query, tick: number, enabled = true) {
  const q = JSON.stringify(query);
  const [state, set] = useState<{ data: T | null; error: string; loading: boolean; loadedAt: number }>({
    data: null, error: '', loading: false, loadedAt: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    set((prev) => ({ ...prev, loading: true }));
    request<T>({ url, query: JSON.parse(q), timeout: 30_000 })
      .then((data) => { if (active) set({ data, error: '', loading: false, loadedAt: Date.now() }); })
      .catch((e) => { if (active) set((prev) => ({ ...prev, error: message(e), loading: false })); });
    return () => { active = false; };
  }, [url, q, tick, enabled]);
  return state;
}

function Empty({ text, todo, detail }: { text: string; todo?: boolean; detail?: string }) {
  return (
    <div className="scr-empty">
      {todo && <span className="scr-tag">待接口</span>}
      <b>{text}</b>
      {detail && <small>{detail}</small>}
    </div>
  );
}

type TrendBucket = { month: string; amountCents: number; count: number };
function TrendChart({ buckets }: { buckets: TrendBucket[] }) {
  const W = 1000, H = 300;
  const max = Math.max(1, ...buckets.map((b) => Math.abs(b.amountCents)));
  const step = buckets.length > 1 ? W / (buckets.length - 1) : W;
  const points = buckets.map((b, i) => ({ x: buckets.length > 1 ? i * step : W / 2, y: H - 26 - (Math.abs(b.amountCents) / max) * (H - 66) }));
  const line = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = points.length ? `M ${points[0].x.toFixed(1)} ${H} L ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} L ${points[points.length - 1].x.toFixed(1)} ${H} Z` : '';
  return (
    <div className="scr-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近 6 个月收缴趋势（按月实收净额）">
        <defs>
          <linearGradient id="scrTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4c9dff" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#4c9dff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} className="scr-gridline" x1="0" y1={H * f} x2={W} y2={H * f} />)}
        {area && <path d={area} fill="url(#scrTrendFill)" />}
        {line && <path d={line} className="scr-line" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="scr-xaxis">
        {buckets.map((b) => (
          <span key={b.month} className={b.amountCents >= 0 ? '' : 'neg'}>
            <b>{compact(b.amountCents)}</b>
            <small>{monthLabel(b.month)}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function AgingBars({ aging }: { aging: Aging }) {
  const total = aging.amountCents || AGING_KEYS.reduce((sum, key) => sum + (aging.buckets[key]?.amountCents || 0), 0);
  const max = Math.max(1, ...AGING_KEYS.map((key) => aging.buckets[key]?.amountCents || 0));
  return (
    <div className="scr-aging">
      {AGING_KEYS.map((key) => {
        const bucket = aging.buckets[key] || { count: 0, amountCents: 0 };
        const share = total ? Math.round((bucket.amountCents / total) * 1000) / 10 : 0;
        return (
          <div className="scr-aging-row" key={key}>
            <div className="scr-aging-head"><span>{AGING_LABELS[key]}</span><b>¥{cents(bucket.amountCents)}</b><em>{share}%</em></div>
            <div className="scr-aging-track"><i className="scr-aging-bar" style={{ width: `${Math.max(bucket.amountCents ? 2 : 0, (bucket.amountCents / max) * 100)}%` }} /></div>
            <small>{bucket.count} 户</small>
          </div>
        );
      })}
      <p className="scr-footnote">账龄按最早未缴账期起算 · 合计 ¥{cents(total)}{aging.truncated ? ` · 仅扫描前 ${aging.scanned} 户，统计不完整` : ''}</p>
    </div>
  );
}

export default function Screen() {
  const navigate = useNavigate();
  const session = useSession();
  const [tick, setTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  const year = chinaDate().slice(0, 4);
  const today = chinaDate();
  const nowUtc = new Date(today + 'T00:00:00Z');
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7));
  const trendFrom = months[0] + '-01';

  const dash = useLive<Dashboard>('/fees/mis/residential', { view: 'dashboard', category: 'all', periodFrom: year + '01', periodTo: year + '12' }, tick);
  const trend = useLive<Trend>('/fees/mis/residential', { view: 'trend', category: 'all', paidFrom: trendFrom, paidTo: today }, tick);
  const houses = useLive<Houses>('/fees/mis/residential', { view: 'households', status: 'unpaid', category: 'all', periodFrom: year + '01', periodTo: year + '12', page: 1, pageSize: 1 }, tick);
  const batches = useLive<Batches>('/fees/mis/collections', { page: 1, pageSize: 100 }, tick);
  const effect = useLive<Effect>('/fees/mis/collections/effect', { windowDays: 30, page: 1, pageSize: 1 }, tick);
  const sms = useLive<SmsStats>('/fees/mis/collections/sms-stats', {}, tick);

  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => setTick((value) => value + 1);
    const start = () => { if (timer === null) timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS); };
    const stop = () => { if (timer !== null) { window.clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else { refresh(); start(); }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* 浏览器不允许时保持窗口模式 */ }
  };

  const summary = dash.data?.summary;
  const paidRate = summary && summary.receivableCents ? Math.round((summary.paidCents / summary.receivableCents) * 1000) / 10 : null;
  const unpaidShare = summary && summary.receivableCents ? Math.round((summary.unpaidCents / summary.receivableCents) * 1000) / 10 : null;
  const loadedAt = Math.max(dash.loadedAt, trend.loadedAt, houses.loadedAt, batches.loadedAt, effect.loadedAt, sms.loadedAt);
  const loading = [dash, trend, houses, batches, effect, sms].some((item) => item.loading);

  const monthly: TrendBucket[] = months.map((month) => {
    const rows = (trend.data?.rows || []).filter((row) => row.day.slice(0, 7) === month);
    return { month, amountCents: rows.reduce((sum, row) => sum + row.netCents, 0), count: rows.length };
  });

  const batchRows = batches.data?.rows || [];
  const batchTotal = batches.data?.total ?? batchRows.length;
  const batchHouses = batchRows.reduce((sum, row) => sum + row.houseCount, 0);
  const latestBatch = batchRows[0];

  const smsTotal = num(sms.data?.total ?? sms.data?.sent ?? sms.data?.count);
  const smsDelivered = num(sms.data?.delivered ?? sms.data?.deliveryCount ?? sms.data?.success);
  const smsRate = typeof sms.data?.deliveryRate === 'number' ? sms.data.deliveryRate : smsTotal ? Math.round((smsDelivered / smsTotal) * 1000) / 10 : null;

  return (
    <div className="screen" data-page="screen">
      <header className="scr-head">
        <div className="scr-brand">
          <span className="scr-mark" aria-hidden="true" />
          <div>
            <h1>收费与催缴看板</h1>
            <p>住宅收费 · 一通MIS · 只读账务 · 1920×1080 投屏</p>
          </div>
        </div>
        <div className="scr-meta">
          <span className="scr-updated">最后更新 {loadedAt ? new Date(loadedAt).toLocaleString('zh-CN', { hour12: false }) : '读取中…'}</span>
          {loading && <span className="scr-live"><i />刷新中</span>}
          <button type="button" className="scr-btn" onClick={() => setTick((value) => value + 1)}>刷新</button>
          <button type="button" className="scr-btn" onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏'}</button>
          <button type="button" className="scr-btn ghost" onClick={() => navigate(firstAllowedPath(session.access) || '/fees')}>返回后台</button>
        </div>
      </header>

      <section className="scr-kpis" aria-label="本期收费指标">
        {dash.error && !summary ? (
          <div className="scr-panel scr-kpi err"><Empty text="MIS 指标读取失败" detail={dash.error} /></div>
        ) : (
          <>
            <article className="scr-panel scr-kpi">
              <span className="scr-kpi-label">本期应收</span>
              <b className="scr-kpi-value due">¥{cents(summary?.receivableCents || 0)}</b>
              <span className="scr-kpi-sub">所选年度非退款账单</span>
            </article>
            <article className="scr-panel scr-kpi">
              <span className="scr-kpi-label">本期已缴</span>
              <b className="scr-kpi-value paid">¥{cents(summary?.paidCents || 0)}</b>
              <span className="scr-kpi-sub">收缴完成率 {paidRate === null ? '—' : paidRate + '%'}</span>
            </article>
            <article className="scr-panel scr-kpi">
              <span className="scr-kpi-label">本期待缴</span>
              <b className="scr-kpi-value owe">¥{cents(summary?.unpaidCents || 0)}</b>
              <span className="scr-kpi-sub">{summary?.unpaidHouses ?? 0} 户未结清{unpaidShare === null ? '' : ' · 占应收 ' + unpaidShare + '%'}</span>
            </article>
            <article className="scr-panel scr-kpi">
              <span className="scr-kpi-label">本期收缴率</span>
              <b className="scr-kpi-value rate">{paidRate === null ? '—' : paidRate + '%'}</b>
              <span className="scr-kpi-sub">按金额，不是按户数</span>
            </article>
          </>
        )}
      </section>

      <section className="scr-mid">
        <article className="scr-panel scr-trend">
          <div className="scr-panel-head">
            <h2>近 6 个月收缴趋势</h2>
            <span className="scr-legend">实收净额 · 按月 · {months[0].replace('-', '/')} – {months[5].replace('-', '/')}</span>
          </div>
          {trend.error ? <Empty text="趋势读取失败" detail={trend.error} /> : trend.data ? <TrendChart buckets={monthly} /> : <Empty text="正在读取趋势…" />}
        </article>

        <article className="scr-panel scr-aging-panel">
          <div className="scr-panel-head">
            <h2>欠费账龄分布</h2>
            <span className="scr-legend">未缴本金 · 4 档</span>
          </div>
          {houses.error ? <Empty text="账龄读取失败" detail={houses.error} /> : houses.data?.aging ? <AgingBars aging={houses.data.aging} /> : <Empty text="正在读取账龄…" />}
        </article>
      </section>

      <section className="scr-bottom" aria-label="催缴成效">
        <article className="scr-panel scr-mini">
          <div className="scr-panel-head"><h2>本轮催缴批次与户数</h2><span className="scr-legend">最近 100 批</span></div>
          {batches.error ? <Empty text="催缴批次读取失败" detail={batches.error} /> : (
            <div className="scr-mini-body">
              <div><b>{batchTotal}</b><small>批次</small></div>
              <div><b>{batchHouses}</b><small>通知户次</small></div>
              <span className="scr-mini-note">{latestBatch ? '最近批次 ' + new Date(latestBatch.createdAt).toLocaleDateString('zh-CN') + (latestBatch.purpose === 'sms' ? ' · 短信' : ' · 纸质') : '暂无批次'}</span>
            </div>
          )}
        </article>

        <article className="scr-panel scr-mini">
          <div className="scr-panel-head"><h2>T+30 回款与回款率</h2><span className="scr-legend">通知批次归因</span></div>
          {effect.error || !effect.data ? (
            effect.loading ? <Empty text="正在核对 T+30 回款…" /> : <Empty text="T+30 回款暂不可用" todo detail={effect.error || undefined} />
          ) : (
            <div className="scr-mini-body">
              <div><b>¥{cents(effect.data.summary.recoveredCents)}</b><small>归因回款</small></div>
              <div><b>{effect.data.summary.recoveryRate}%</b><small>金额回款率</small></div>
              <span className="scr-mini-note">通知金额 ¥{cents(effect.data.summary.notifiedCents)} · 缴清 {effect.data.summary.clearedHouseholds} 户</span>
            </div>
          )}
        </article>

        <article className="scr-panel scr-mini">
          <div className="scr-panel-head"><h2>短信送达率</h2><span className="scr-legend">催缴短信</span></div>
          {sms.error ? <Empty text="短信送达率暂不可用" todo detail={sms.error} /> : sms.data ? (
            <div className="scr-mini-body">
              <div><b>{smsRate === null ? '—' : smsRate + '%'}</b><small>送达率</small></div>
              <div><b>{smsDelivered || '—'}</b><small>已送达</small></div>
              <span className="scr-mini-note">共 {smsTotal || '—'} 条 · 数据来自短信发送记录</span>
            </div>
          ) : <Empty text="正在读取短信送达…" />}
        </article>
      </section>
    </div>
  );
}
