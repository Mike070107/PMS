import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { request } from '@pms/api-client';
import { cents, chinaDate } from '@/lib/residential-bills';
import { firstAllowedPath } from '@/lib/page-access';
import { useSession } from '@/lib/auth';
import ThreeBackdrop from '@/components/ThreeBackdrop';
import '@/styles/screen.css';

type Query = Record<string, string | number | boolean | undefined>;
type Summary = { receivableCents: number; paidCents: number; unpaidCents: number; unpaidHouses: number; adjustmentCount?: number };
type Dashboard = { summary: Summary; queriedAt?: string };
type Trend = { rows: { day: string; netCents: number; chargedCents: number; refundedCents: number }[] };
type AmountBracketKey = 'le500' | '500to2000' | '2000to5000' | 'gt5000';
type AmountBucket = { key: AmountBracketKey; label: string; count: number; amountCents: number };
type AmountBracketsResponse = { buckets?: Array<{ key?: string; count?: number; amountCents?: number }>; total?: { count?: number; amountCents?: number } };
type RecentPayment = { paidAt: string; address: string; ownerName: string; amountCents: number; channel?: string | null; billCount: number; recordedAt?: string | null; communityName?: string };
type Communities = { rows: { id: number; name: string; unpaidCents: number; unpaidHouses: number }[] };
type Batch = { id: number; createdAt: string; purpose: 'print' | 'sms'; houseCount: number; amountCents: string };
type Batches = { rows: Batch[]; total: number };
type Effect = { summary: { notifiedCents: number; recoveredCents: number; recoveryRate: number; clearedHouseholds: number }; invalidPaidDateCount?: number };
type SmsStats = Record<string, unknown>;
type Options = { available?: boolean; message?: string; communities: { id: number; name: string }[] };

type ScreenTarget = { annualCents: number; paidCents: number; gapCents: number; remainingDays: number; dailyNeedCents: number; rate: number | null; hasTarget: boolean; partial: boolean; targetScope: string; missingTargetCommunities: string[] };
type ScreenToday = { paidCents: number; count: number; houses: number; dailyNeedCents: number; vsDailyNeed: number | null };
type ScreenTrendPoint = { key: string; label: string; paidCents: number; targetCents: number; cumPaidCents: number; cumTargetCents: number };
type ScreenCommunity = { id: number; name: string; targetCents: number; paidCents: number; rate: number | null; hasTarget: boolean };
type ScreenArrearsBucket = { key: string; label: string; count: number; amountCents: number };
type ScreenArrears = { buckets: ScreenArrearsBucket[]; totalCount: number; totalAmountCents: number };
type ScreenMonth = { paidCents: number; targetCents: number; rate: number | null; targetSource: string; month: string; hasTarget: boolean };
type ScreenSummary = { year: number; target: ScreenTarget; monthToDate: ScreenMonth; today: ScreenToday; trend: ScreenTrendPoint[]; communities: ScreenCommunity[]; arrears: ScreenArrears | null };
const SCREEN_ARREARS_META: { key: string; label: string }[] = [
  { key: 'le500', label: '≤¥500' }, { key: '500to2000', label: '¥500–2000' },
  { key: '2000to5000', label: '¥2000–5000' }, { key: 'gt5000', label: '>¥5000' },
];
function normalizeScreenSummary(raw: unknown): ScreenSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, any>;
  const targetRaw = data.target && typeof data.target === 'object' ? data.target : {};
  const todayRaw = data.today && typeof data.today === 'object' ? data.today : {};
  const annualCents = num(targetRaw.annualCents ?? targetRaw.annualTargetCents ?? targetRaw.targetCents ?? targetRaw.amountCents ?? data.annualTargetCents ?? data.targetCents);
  // 已收必须用年度累计（yearToDateCents），不能用 monthToDate 或全范围合计
  const paidCents = num(targetRaw.yearToDateCents ?? targetRaw.paidCents ?? data.yearToDateCents ?? data.paidCents);
  const gapCents = num(targetRaw.gapCents ?? targetRaw.gap ?? data.gapCents ?? (annualCents ? annualCents - paidCents : 0));
  const remainingDays = num(targetRaw.remainingDays ?? data.remainingDays);
  const dailyNeedCents = num(targetRaw.dailyNeedCents ?? data.dailyNeedCents ?? (remainingDays > 0 ? Math.max(0, gapCents) / remainingDays : 0));
  const rateRaw = Number(targetRaw.rate ?? targetRaw.progress ?? (annualCents ? (paidCents / annualCents) * 100 : NaN));
  const hasTarget = annualCents > 0;
  const missingRaw = targetRaw.missingTargetCommunities ?? data.missingTargetCommunities;
  const missingTargetCommunities = Array.isArray(missingRaw) ? missingRaw.map((item: any) => typeof item === 'string' ? item : String(item?.name ?? '')).filter(Boolean) : [];
  const scopeRaw = targetRaw.targetScope ?? data.targetScope;
  const targetScope = typeof scopeRaw === 'string' ? scopeRaw
    : Array.isArray(scopeRaw) ? scopeRaw.map((item: any) => typeof item === 'string' ? item : String(item?.name ?? '')).filter(Boolean).join('、')
      : Array.isArray(scopeRaw?.communityNames) ? scopeRaw.communityNames.filter(Boolean).join('、')
        : Array.isArray(scopeRaw?.names) ? scopeRaw.names.filter(Boolean).join('、')
          : String(scopeRaw?.name ?? scopeRaw?.label ?? scopeRaw?.communityName ?? '');
  const partial = Boolean(targetRaw.partial ?? data.partial ?? missingTargetCommunities.length > 0);
  const target: ScreenTarget = { annualCents, paidCents, gapCents, remainingDays, dailyNeedCents: Math.round(dailyNeedCents), rate: Number.isFinite(rateRaw) ? Math.round(rateRaw * 10) / 10 : null, hasTarget, partial, targetScope, missingTargetCommunities };
  const monthRaw = data.monthToDate && typeof data.monthToDate === 'object' ? data.monthToDate : {};
  const monthTargetCents = num(monthRaw.targetCents ?? monthRaw.target ?? 0);
  const monthPaidCents = num(monthRaw.paidCents);
  const monthRateRaw = Number(monthRaw.rate ?? (monthTargetCents > 0 ? (monthPaidCents / monthTargetCents) * 100 : NaN));
  const monthToDate: ScreenMonth = {
    paidCents: monthPaidCents,
    targetCents: monthTargetCents,
    rate: Number.isFinite(monthRateRaw) ? Math.round(monthRateRaw * 10) / 10 : null,
    targetSource: String(monthRaw.targetSource ?? ''),
    month: String(monthRaw.month ?? ''),
    hasTarget: monthTargetCents > 0,
  };
  const today: ScreenToday = {
    paidCents: num(todayRaw.paidCents ?? todayRaw.amountCents),
    count: num(todayRaw.billCount ?? todayRaw.count ?? todayRaw.paidCount),
    houses: num(todayRaw.houseCount ?? todayRaw.houses ?? todayRaw.paidHouses),
    dailyNeedCents: num(todayRaw.dailyNeedCents ?? todayRaw.targetCents ?? dailyNeedCents),
    vsDailyNeed: todayRaw.vsDailyNeed === null || todayRaw.vsDailyNeed === undefined ? null : num(todayRaw.vsDailyNeed),
  };
  const trendRaw = Array.isArray(data.trend) ? data.trend : Array.isArray(data.months) ? data.months : [];
  let cumPaid = 0; let cumTarget = 0;
  const trend: ScreenTrendPoint[] = trendRaw.map((row: any, index: number) => {
    const key = String(row?.key ?? row?.date ?? row?.month ?? row?.bucket ?? index + 1);
    const paid = num(row?.paidCents ?? row?.amountCents ?? row?.paid);
    const targetCents = num(row?.targetCents ?? row?.target ?? row?.indicatorCents);
    cumPaid += paid; cumTarget += targetCents;
    return {
      key,
      label: String(row?.label ?? (key.length >= 7 ? monthLabel(key) : key)),
      paidCents: paid,
      targetCents,
      cumPaidCents: num(row?.cumPaidCents ?? row?.cumulativePaidCents) || cumPaid,
      cumTargetCents: num(row?.cumTargetCents ?? row?.cumulativeTargetCents) || cumTarget,
    };
  });
  const communitiesRaw = Array.isArray(data.communities) ? data.communities : [];
  const communities: ScreenCommunity[] = communitiesRaw.map((row: any, index: number) => {
    const annual = num(row?.targetCents ?? row?.annualCents ?? row?.target?.annualCents);
    const paid = num(row?.paidCents ?? row?.paidCentsYear ?? row?.paid);
    const has = annual > 0;
    return { id: Number(row?.id ?? index), name: String(row?.name ?? row?.communityName ?? '未命名小区'), targetCents: annual, paidCents: paid, rate: has ? Math.round((paid / annual) * 1000) / 10 : null, hasTarget: has };
  });
  let arrears: ScreenArrears | null = null;
  const arrearsRaw = data.arrears && typeof data.arrears === 'object' ? data.arrears : null;
  if (arrearsRaw) {
    const bucketsRaw = Array.isArray(arrearsRaw.buckets) ? arrearsRaw.buckets : Array.isArray(arrearsRaw.rows) ? arrearsRaw.rows : [];
    const byKey = new Map(bucketsRaw.map((bucket: any) => [String(bucket?.key ?? bucket?.bucket ?? ''), bucket]));
    const buckets = SCREEN_ARREARS_META.map(({ key, label }) => {
      const hit: any = byKey.get(key);
      return { key, label, count: num(hit?.count ?? hit?.houses), amountCents: num(hit?.amountCents ?? hit?.amount) };
    });
    arrears = {
      buckets,
      totalCount: num(arrearsRaw.total?.count ?? arrearsRaw.totalCount ?? buckets.reduce((sum, bucket) => sum + bucket.count, 0)),
      totalAmountCents: num(arrearsRaw.total?.amountCents ?? arrearsRaw.totalAmountCents ?? buckets.reduce((sum, bucket) => sum + bucket.amountCents, 0)),
    };
  }
  return { year: num(data.year) || new Date().getFullYear(), target, monthToDate, today, trend, communities, arrears };
}

const REFRESH_MS = 300_000;
const AMOUNT_BUCKETS = [
  { key: 'le500', label: '≤¥500' },
  { key: '500to2000', label: '¥500–2000' },
  { key: '2000to5000', label: '¥2000–5000' },
  { key: 'gt5000', label: '>¥5000' },
] as const;
/** 新接口一次返回四档；缺档补 0，total 直接用接口合计。 */
function normalizeBrackets(raw: AmountBracketsResponse) {
  const byKey = new Map((raw.buckets || []).map((bucket) => [String(bucket.key), bucket]));
  const buckets: AmountBucket[] = AMOUNT_BUCKETS.map(({ key, label }) => {
    const hit = byKey.get(key);
    return { key, label, count: Number(hit?.count) || 0, amountCents: Number(hit?.amountCents) || 0 };
  });
  return {
    buckets,
    total: {
      count: Number(raw.total?.count) || buckets.reduce((sum, bucket) => sum + bucket.count, 0),
      amountCents: Number(raw.total?.amountCents) || buckets.reduce((sum, bucket) => sum + bucket.amountCents, 0),
    },
  };
}

/** 解析 MIS 离线/镜像状态；字段未就绪时按在线处理。只用于右上角小字，不弹告警。 */
function offlineStatus(raw: unknown) {
  const meta = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  const mirror = (meta.mirror && typeof meta.mirror === 'object' ? meta.mirror : meta.sync && typeof meta.sync === 'object' ? meta.sync : {}) as Record<string, any>;
  const offline = meta.offline === true || meta.misOffline === true || meta.misOnline === false
    || meta.isOffline === true || meta.stale === true || mirror.offline === true
    || /镜像/.test(String(meta.sourceLabel || ''));
  if (!offline) return { offline: false, asOf: null as string | null, stale: false };
  const rawAsOf = meta.dataAsOf ?? meta.dataAsOfAt ?? meta.asOf ?? meta.mirrorAsOf ?? meta.syncedAt
    ?? meta.lastSyncedAt ?? meta.mirrorSyncedAt ?? mirror.syncedAt ?? meta.queriedAt ?? null;
  let clock: string | null = null;
  let stale = false;
  if (rawAsOf) {
    const text = String(rawAsOf);
    const direct = /(\d{2}):(\d{2})/.exec(text);
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      clock = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
      stale = Date.now() - date.getTime() > 15 * 60_000;
    } else if (direct) clock = direct[1] + ':' + direct[2];
  }
  return { offline: true, asOf: clock, stale };
}

function message(e: unknown) {
  const text = e instanceof Error ? e.message : '';
  return /[\u4e00-\u9fff]/.test(text) ? text : '接口读取失败，稍后重试';
}
function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
/** 大屏横轴/金额缩写：≥1 万元用「万」，避免多月标签挤在一起。 */
function compact(centsValue: number) {
  if (!Number.isFinite(centsValue)) return '¥0';
  if (Math.abs(centsValue) >= 1_000_000) return '¥' + (centsValue / 1_000_000).toFixed(1) + '万';
  return '¥' + cents(centsValue);
}
/** 月份标签：YY-MM，例如 26-06，跨年时不混淆。 */
function monthLabel(month: string) {
  return `${month.slice(2, 4)}-${month.slice(5, 7)}`;
}

/** 每次 signal 变化取一次；60 秒的 signal 由页面定时器推进，页面隐藏时暂停。 */
function useLive<T>(url: string, query: Query, signal: string) {
  const q = JSON.stringify(query);
  const [state, set] = useState<{ data: T | null; error: string; loading: boolean; loadedAt: number }>({
    data: null, error: '', loading: false, loadedAt: 0,
  });
  useEffect(() => {
    let active = true;
    set((prev) => ({ ...prev, loading: true }));
    request<T>({ url, query: JSON.parse(q), timeout: 30_000 })
      .then((data) => { if (active) set({ data, error: '', loading: false, loadedAt: Date.now() }); })
      .catch((e) => { if (active) set((prev) => ({ ...prev, error: message(e), loading: false })); });
    return () => { active = false; };
  }, [url, q, signal]);
  return state;
}

/** 北京时间自然日回退：用于近期缴费向前找最近有收款的一天。 */
function shiftChinaDate(date: string, delta: number) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

type RecentPaymentsState = { rows: RecentPayment[]; date: string | null; error: string; loadedAt: number; loading: boolean };
/** 近期缴费：先取今天；为空则向前最多回退 7 天，取最近有收款的一天（最多 10 笔）。 */
function useRecentPayments(baseQuery: Query, signal: string) {
  const q = JSON.stringify(baseQuery);
  const [state, set] = useState<RecentPaymentsState>({ rows: [], date: null, error: '', loadedAt: 0, loading: false });
  useEffect(() => {
    let active = true;
    set((prev) => ({ ...prev, error: '', loading: true }));
    (async () => {
      const today = chinaDate();
      for (let offset = 0; offset <= 6; offset += 1) {
        const date = shiftChinaDate(today, -offset);
        try {
          const data = await request<unknown>({ url: '/fees/mis/recent-payments', query: { ...JSON.parse(q), date, page: 1, pageSize: 10 }, timeout: 30_000 });
          if (!active) return;
          const rows: RecentPayment[] = Array.isArray(data) ? data as RecentPayment[] : Array.isArray((data as any)?.rows) ? (data as any).rows : Array.isArray((data as any)?.list) ? (data as any).list : [];
          if (rows.length) { set({ rows, date, error: '', loadedAt: Date.now(), loading: false }); return; }
        } catch (e) {
          if (!active) return;
          set({ rows: [], date: null, error: message(e), loadedAt: 0, loading: false });
          return;
        }
      }
      if (active) set({ rows: [], date: null, error: '', loadedAt: Date.now(), loading: false });
    })();
    return () => { active = false; };
  }, [q, signal]);
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
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="按月收缴趋势（实收净额）">
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

function AmountBars({ buckets, totalAmount, totalCount }: { buckets: AmountBucket[]; totalAmount: number; totalCount: number }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.amountCents));
  return (
    <div className="scr-aging">
      {buckets.map((bucket) => {
        const share = totalAmount ? Math.round((bucket.amountCents / totalAmount) * 1000) / 10 : 0;
        return (
          <div className="scr-aging-row" key={bucket.key}>
            <div className="scr-aging-head"><span>{bucket.label}</span><b>¥{cents(bucket.amountCents)}</b><em>{share}%</em></div>
            <div className="scr-aging-track"><i className="scr-aging-bar" style={{ width: `${Math.max(bucket.amountCents ? 2 : 0, (bucket.amountCents / max) * 100)}%` }} /></div>
            <small>{bucket.count} 户</small>
          </div>
        );
      })}
      <p className="scr-footnote">按户待缴总额分档 · 合计 ¥{cents(totalAmount)} · {totalCount} 户</p>
    </div>
  );
}

function RollingCents({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (value - from) * eased);
      current.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>¥{cents(shown)}</>;
}

function NoData({ text = '暂无数据' }: { text?: string }) {
  return <div className="scr-no-data">{text}</div>;
}

function AnnualProgress({ rate, over }: { rate: number; over: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const measure = () => setWidth(Math.max(120, Math.round(host.getBoundingClientRect().width)));
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const height = 24;
  const radius = height / 2;
  const filled = Math.max(height, Math.min(1, Math.max(0, rate) / 100) * width);
  return (
    <div ref={hostRef} className="scr-target-bar-host">
      <svg className="scr-target-bar-svg" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`年度达成 ${rate}%`}>
        <defs>
          <linearGradient id="scrTargetGreenRounded" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#1f8f68" /><stop offset="1" stopColor="#7bf0c0" /></linearGradient>
          <linearGradient id="scrTargetGoldRounded" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#b8860b" /><stop offset="1" stopColor="#ffe28a" /></linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx={radius} ry={radius} fill="rgba(120,168,255,.16)" />
        <rect x="0" y="0" width={filled} height={height} rx={radius} ry={radius} fill={over ? 'url(#scrTargetGoldRounded)' : 'url(#scrTargetGreenRounded)'} />
      </svg>
    </div>
  );
}

function AnnualPanel({ target, year, loading, error, onSettings }: { target: ScreenTarget | null; year: string; loading: boolean; error: string; onSettings: () => void }) {
  if (error) return <article className="scr-panel scr-annual"><div className="scr-panel-head"><h2>{year} 年度达成</h2></div><NoData /></article>;
  if (!target) return <article className="scr-panel scr-annual"><div className="scr-panel-head"><h2>{year} 年度达成</h2></div>{loading ? <div className="scr-no-data">读取中…</div> : <NoData />}</article>;
  if (!target.hasTarget) {
    return (
      <article className="scr-panel scr-annual">
        <div className="scr-panel-head"><h2>{year} 年度达成</h2><span className="scr-legend">年度指标</span></div>
        <div className="scr-target-empty"><b>未设置年度指标</b><span>设置后这里会显示年度达成进度与缺口</span><button type="button" className="scr-btn" onClick={onSettings}>设置年度指标</button></div>
      </article>
    );
  }
  const rate = target.rate ?? 0;
  const over = rate > 100;
  const width = Math.min(100, Math.max(0, rate));
  return (
    <article className={'scr-panel scr-annual' + (over ? ' over' : '')}>
      <div className="scr-panel-head"><h2>{year} 年度达成</h2><span className="scr-legend">{target.partial ? '部分口径' : '年度指标'}</span></div>
      <div className="scr-target-line"><span>年度指标 ¥{cents(target.annualCents)}</span><i /> <span>已收 ¥{cents(target.paidCents)}</span></div>
      <div className="scr-target-bar-wrap">
        <AnnualProgress rate={rate} over={over} />
        {target.partial ? <em className="scr-partial-tag">部分口径</em> : null}<b className={'scr-target-pct' + (over ? ' over' : '')}>{rate}%</b>
      </div>
      <div className="scr-target-sub">
        <span>缺口 ¥{cents(Math.max(0, target.gapCents))}</span><i />
        <span>剩余 {target.remainingDays} 天</span><i />
        <span>日均需收 ¥{cents(target.dailyNeedCents)}</span>
        {over ? <em className="scr-over-tag">已超额</em> : null}
      </div>
      {target.partial ? <div className="scr-target-scope">指标口径：仅 {target.targetScope || '已设指标小区'}{target.missingTargetCommunities.length ? `（另有 ${target.missingTargetCommunities.join('、')} 未设指标）` : ''}</div> : null}
    </article>
  );
}

function MonthPanel({ month }: { month: ScreenMonth | null }) {
  if (!month) return <article className="scr-panel scr-month-kpi"><div className="scr-panel-head"><h2>月度达成</h2></div><NoData /></article>;
  if (!month.hasTarget) {
    return (
      <article className="scr-panel scr-month-kpi">
        <div className="scr-panel-head"><h2>月度达成</h2><span className="scr-legend">{month.month || '本月'}</span></div>
        <div className="scr-kpi-empty"><b>未设指标</b><span>本月未配置月度目标</span></div>
      </article>
    );
  }
  const rate = month.rate ?? 0;
  const over = rate > 100;
  return (
    <article className={'scr-panel scr-month-kpi' + (over ? ' over' : '')}>
      <div className="scr-panel-head"><h2>月度达成</h2><span className="scr-legend">{month.month || '本月'}</span></div>
      <div className="scr-kpi-pct-row">
        {over ? <em className="scr-partial-tag gold">已超额</em> : null}
        <b className={'scr-target-pct' + (over ? ' over' : '')}>{rate}%</b>
      </div>
      <AnnualProgress rate={rate} over={over} />
      <div className="scr-kpi-lines">
        <span>目标 ¥{cents(month.targetCents)}{month.targetSource === 'derived' ? <small>按年度均摊</small> : null}</span>
        <span>已收 ¥{cents(month.paidCents)}</span>
      </div>
    </article>
  );
}

function TodayRing({ pct }: { pct: number | null }) {
  const safe = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const r = 24;
  const circumference = 2 * Math.PI * r;
  return (
    <div className={'scr-today-ring' + (pct !== null && pct >= 100 ? ' done' : '')}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(120,168,255,.16)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(safe / 100) * circumference} ${circumference}`} transform="rotate(-90 32 32)" />
      </svg>
      <span className={pct === null ? 'idle' : ''}>{pct === null ? '未设指标' : Math.round(pct) + '%'}</span>
    </div>
  );
}

function CumulativeChart({ points, year, granularity, annualTargetCents }: { points: ScreenTrendPoint[]; year: number; granularity: 'day' | 'month'; annualTargetCents: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <NoData />;
  const W = 900; const H = 300;
  const pad = { l: 48, r: 16, t: 26, b: 30 };
  const isDay = granularity === 'day' && points[0].key.length >= 10;
  const daysInYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
  const fraction = (key: string) => {
    if (isDay) {
      const day = Date.parse(key + 'T00:00:00Z');
      const startDay = Date.parse(year + '-01-01T00:00:00Z');
      return Math.min(1, Math.max(0, (day - startDay) / 86400000 / daysInYear));
    }
    const month = Number(key.slice(5, 7));
    return Math.min(1, Math.max(0, (month - 1) / 11));
  };
  const px = (index: number) => pad.l + fraction(points[index].key) * (W - pad.l - pad.r);
  const rawMax = Math.max(1, ...points.map((point) => Math.max(point.cumPaidCents, point.cumTargetCents)), annualTargetCents || 0) * 1.15;
  const rawStep = rawMax / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const max = Math.ceil(rawMax / step) * step;
  const py = (value: number) => pad.t + (1 - value / max) * (H - pad.t - pad.b);
  const paidPath = points.map((point, index) => `${index ? 'L' : 'M'} ${px(index)} ${py(point.cumPaidCents)}`).join(' ');
  const targetPath = points.map((point, index) => `${index ? 'L' : 'M'} ${px(index)} ${py(point.cumTargetCents)}`).join(' ');
  const last = points[points.length - 1];
  const refTarget = annualTargetCents > 0 ? annualTargetCents : last.cumTargetCents;
  const diff = last.cumPaidCents - refTarget;
  const rate = refTarget > 0 ? Math.round((last.cumPaidCents / refTarget) * 1000) / 10 : null;
  const fmtWan = (value: number) => (value / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '万';
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => ({ value: index * step, y: py(index * step) }));
  const monthMarks = isDay
    ? [1, 4, 7, 10].map((month) => ({ key: String(month), frac: (Date.UTC(year, month - 1, 1) - Date.UTC(year, 0, 1)) / 86400000 / daysInYear, label: String(month).padStart(2, '0') + '-01' }))
      .concat([{ key: 'end', frac: 1, label: '12-31' }])
    : [1, 4, 7, 10].map((month) => ({ key: String(month), frac: (month - 1) / 11, label: String(month).padStart(2, '0') }))
      .concat([{ key: 'end', frac: 1, label: '12' }]);
  return (
    <div className="scr-cum-chart" onMouseLeave={() => setHover(null)}>
      <div className={'scr-cum-diff ' + (diff >= 0 ? 'lead' : 'lag')}>{diff >= 0 ? '超前' : '落后'} ¥{cents(Math.abs(diff))}{rate !== null ? ' · 达成 ' + rate + '%' : ''}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
        {ticks.map((tick) => <line key={tick.y} className="scr-gridline" x1={pad.l} y1={tick.y} x2={W - pad.r} y2={tick.y} />)}
        {ticks.filter((tick) => tick.value > 0).map((tick) => <text key={'tick' + tick.y} x={pad.l - 7} y={tick.y + 3.5} className="scr-axis-label" textAnchor="end">{fmtWan(tick.value)}</text>)}
        {monthMarks.map((mark) => <line key={'v' + mark.key} className="scr-gridline v" x1={pad.l + mark.frac * (W - pad.l - pad.r)} y1={pad.t} x2={pad.l + mark.frac * (W - pad.l - pad.r)} y2={H - pad.b} />)}
        {points.slice(0, -1).map((point, index) => {
          const next = points[index + 1];
          const d = `M ${px(index)} ${py(point.cumPaidCents)} L ${px(index + 1)} ${py(next.cumPaidCents)} L ${px(index + 1)} ${py(next.cumTargetCents)} L ${px(index)} ${py(point.cumTargetCents)} Z`;
          return <path key={'band' + point.key} d={d} className={'scr-cum-seg ' + ((point.cumPaidCents + next.cumPaidCents) / 2 >= (point.cumTargetCents + next.cumTargetCents) / 2 ? 'lead' : 'lag')} />;
        })}
        {annualTargetCents > 0 ? (
          <g>
            <line className="scr-goal-line" x1={pad.l} y1={py(annualTargetCents)} x2={W - pad.r} y2={py(annualTargetCents)} />
            <text className="scr-goal-label" x={W - pad.r} y={py(annualTargetCents) - 6} textAnchor="end">目标 ¥{fmtWan(annualTargetCents)}（100%）</text>
          </g>
        ) : null}
        <path d={targetPath} className="scr-cum-target" />
        <path d={paidPath} className="scr-cum-paid" />
        {points.map((point, index) => (
          <rect key={'hit' + point.key} x={px(index) - Math.max(3, (W - pad.l - pad.r) / points.length / 2)} y={pad.t} width={Math.max(6, (W - pad.l - pad.r) / points.length)} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(index)} />
        ))}
        {monthMarks.map((mark) => <text key={'x' + mark.key} x={pad.l + mark.frac * (W - pad.l - pad.r)} y={H - 8} className="scr-chart-label" textAnchor={mark.frac === 1 ? 'end' : 'middle'}>{mark.label}</text>)}
        {hover !== null ? <circle cx={px(hover)} cy={py(points[hover].cumPaidCents)} r={4} className="scr-point" /> : null}
      </svg>
      {hover !== null ? (
        <div className="scr-chart-tip" style={{ left: `${(px(hover) / W) * 100}%` }}>
          <b>{points[hover].key}</b>
          <span>实收累计 ¥{cents(points[hover].cumPaidCents)} · 目标累计 ¥{cents(points[hover].cumTargetCents)}</span>
          <span className={points[hover].cumPaidCents >= points[hover].cumTargetCents ? 'lead' : 'lag'}>差额 {points[hover].cumPaidCents >= points[hover].cumTargetCents ? '+' : '-'}¥{cents(Math.abs(points[hover].cumPaidCents - points[hover].cumTargetCents))}</span>
          <span>达成率 {annualTargetCents > 0 ? Math.round((points[hover].cumPaidCents / annualTargetCents) * 1000) / 10 + '%' : '—'}</span>
        </div>
      ) : null}
    </div>
  );
}

function MonthlyChart({ months }: { months: { key: string; label: string; paidCents: number; targetCents: number; current: boolean }[] }) {
  if (!months.length) return <NoData />;
  const W = 800; const H = 180;
  const pad = { l: 12, r: 12, t: 12, b: 24 };
  const max = Math.max(1, ...months.map((month) => Math.max(month.paidCents, month.targetCents)));
  const slot = (W - pad.l - pad.r) / months.length;
  const barW = Math.max(8, slot * 0.5);
  const py = (value: number) => pad.t + (1 - value / max) * (H - pad.t - pad.b);
  const targetLine = months.map((month, index) => `${index ? 'L' : 'M'} ${pad.l + slot * index + slot / 2} ${py(month.targetCents)}`).join(' ');
  return (
    <svg className="scr-month-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="月度实收与指标">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} className="scr-gridline" x1={pad.l} y1={py(max * f)} x2={W - pad.r} y2={py(max * f)} />)}
      {months.map((month, index) => {
        const x = pad.l + slot * index + (slot - barW) / 2;
        const y = py(month.paidCents);
        return <rect key={month.key} x={x} y={y} width={barW} height={Math.max(1, H - pad.b - y)} rx="3" className={'scr-month-bar ' + (month.paidCents >= month.targetCents ? 'ok' : 'low') + (month.current ? ' current' : '')} />;
      })}
      <path d={targetLine} className="scr-month-target" />
      {months.map((month, index) => <text key={'m' + month.key} x={pad.l + slot * index + slot / 2} y={H - 7} className="scr-chart-label" textAnchor="middle">{month.label}</text>)}
    </svg>
  );
}

function CommunityRanking({ rows, selectedIds, onPick }: { rows: ScreenCommunity[]; selectedIds: number[]; onPick: (id: number) => void }) {
  if (!rows.length) return <NoData />;
  const sorted = [...rows].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  return (
    <div className="scr-community-list">
      {sorted.map((row) => (
        <button type="button" key={row.id} className={'scr-community-row' + (selectedIds.length === 1 && selectedIds[0] === row.id ? ' picked' : '')} onClick={() => onPick(row.id)} title="只选该小区">
          <span className="scr-community-name">{row.name}</span>
          <span className="scr-community-track"><i className={row.hasTarget ? (row.rate !== null && row.rate >= 100 ? 'ok' : '') : 'none'} style={{ width: row.hasTarget ? `${Math.min(100, Math.max(0, row.rate ?? 0))}%` : '100%' }} /></span>
          <span className={'scr-community-rate' + (row.hasTarget ? '' : ' none')}>{row.hasTarget ? (row.rate ?? 0) + '%' : '未设指标'}</span>
        </button>
      ))}
    </div>
  );
}

function ScreenArrearsBars({ arrears }: { arrears: ScreenArrears | null }) {
  if (!arrears) return <NoData />;
  const max = Math.max(1, ...arrears.buckets.map((bucket) => bucket.amountCents));
  return (
    <div className="scr-aging">
      {arrears.buckets.map((bucket) => {
        const share = arrears.totalAmountCents ? Math.round((bucket.amountCents / arrears.totalAmountCents) * 1000) / 10 : 0;
        return (
          <div className="scr-aging-row" key={bucket.key}>
            <div className="scr-aging-head"><span>{bucket.label}</span><b>¥{cents(bucket.amountCents)}</b><em>{share}%</em></div>
            <div className="scr-aging-track"><i className="scr-aging-bar" style={{ width: `${Math.max(bucket.amountCents ? 2 : 0, (bucket.amountCents / max) * 100)}%` }} /></div>
          </div>
        );
      })}
      <p className="scr-footnote">按户待缴总额分档 · 合计 ¥{cents(arrears.totalAmountCents)} · {arrears.totalCount} 户</p>
    </div>
  );
}

export default function Screen() {
  const navigate = useNavigate();
  const session = useSession();
  const [tick, setTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [community, setCommunity] = useState('');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [tickerIndex, setTickerIndex] = useState(0);
  const currentYear = chinaDate().slice(0, 4);
  const [year, setYear] = useState(currentYear);
  const [selectedCommunities, setSelectedCommunities] = useState<number[]>([]);
  const [granularity, setGranularity] = useState<'day' | 'month'>('day');
  const [communityMenuOpen, setCommunityMenuOpen] = useState(false);
  const communityMenuRef = useRef<HTMLDivElement | null>(null);

  // 跟随顶栏管理处：actingOffice / 登录代次变化时，重置范围；activeOffice 与范围在同一次更新里提交，避免先按旧小区请求一次。
  const officeKey = JSON.stringify([session.user?.id, session.actingTenant?.id, session.actingOffice?.id, session.generation]);
  const [activeOffice, setActiveOffice] = useState(officeKey);
  useEffect(() => {
    if (activeOffice === officeKey) return;
    setActiveOffice(officeKey);
    setCommunity('');
    setYear(currentYear);
  }, [officeKey, activeOffice, currentYear]);

  // 范围（小区/年度）、自动刷新、管理处任一变化都推进 signal，全部请求一起重拉。
  const signal = `${tick}|${activeOffice}|${community}|${year}|${selectedCommunities.join(',')}|${granularity}`;

  const today = chinaDate();
  const communityId = community ? Number(community) : undefined;
  const yearMonths = year === currentYear
    ? Array.from({ length: Number(today.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const yearFrom = `${year}-01-01`;
  const yearTo = year === currentYear ? today : `${year}-12-31`;
  const yearOptions = Array.from({ length: 4 }, (_, i) => String(Number(currentYear) - i));

  const options = useLive<Options>('/fees/mis/options', {}, signal);
  const screenSummary = useLive<unknown>('/fees/mis/screen-summary', { year, communityIds: selectedCommunities.length ? selectedCommunities.join(',') : undefined, granularity }, signal);
  const dash = useLive<Dashboard>('/fees/mis/residential', { view: 'dashboard', category: 'all', communityId, periodFrom: `${year}01`, periodTo: `${year}12` }, signal);
  const trend = useLive<Trend>('/fees/mis/residential', { view: 'trend', category: 'all', communityId, paidFrom: yearFrom, paidTo: yearTo }, signal);
  const brackets = useLive<AmountBracketsResponse>('/fees/mis/residential', { view: 'amount-brackets', communityId, periodFrom: `${year}01`, periodTo: `${year}12` }, signal);
  const recent = useRecentPayments({ limit: 10, communityId }, signal);
  const batches = useLive<Batches>('/fees/mis/collections', { communityId, page: 1, pageSize: 100 }, signal);
  const effect = useLive<Effect>('/fees/mis/collections/effect', { communityId, windowDays: 30, page: 1, pageSize: 1 }, signal);
  const sms = useLive<SmsStats>('/fees/mis/collections/sms-stats', { communityId, from: yearFrom, to: yearTo }, signal);
  const communityData = useLive<Communities>('/fees/mis/residential', { view: 'communities', category: 'all', communityId, periodFrom: `${year}01`, periodTo: `${year}12` }, signal);

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

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* 浏览器不允许时保持窗口模式 */ }
  };

  const communities = options.data?.communities || [];
  useEffect(() => {
    if (!communities.length) return;
    setSelectedCommunities((prev) => (prev.length ? prev : communities.map((item) => item.id)));
  }, [options.data]);
  const sync = offlineStatus(dash.data ?? options.data);
  const offlineMode = sync.offline;
  const quietEmpty = (text: string, detail?: string) => offlineMode
    ? <Empty text="MIS 同步中，稍后自动刷新" />
    : <Empty text={text} detail={detail} />;
  const summary = dash.data?.summary;
  const paidRate = summary && summary.receivableCents ? Math.round((summary.paidCents / summary.receivableCents) * 1000) / 10 : null;
  const unpaidShare = summary && summary.receivableCents ? Math.round((summary.unpaidCents / summary.receivableCents) * 1000) / 10 : null;
  const loadedAt = Math.max(dash.loadedAt, trend.loadedAt, brackets.loadedAt, batches.loadedAt, effect.loadedAt, sms.loadedAt, recent.loadedAt, screenSummary.loadedAt);
  const lastUpdatedClock = loadedAt ? new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Shanghai' }) : null;
  const staleAsOf = sync.stale && sync.asOf ? sync.asOf : null;
  const loading = [dash, trend, brackets, batches, effect, sms, recent, screenSummary].some((item) => item.loading);

  const monthly: TrendBucket[] = yearMonths.map((month) => {
    const rows = (trend.data?.rows || []).filter((row) => row.day.slice(0, 7) === month);
    return { month, amountCents: rows.reduce((sum, row) => sum + row.netCents, 0), count: rows.length };
  });

  const batchRows = batches.data?.rows || [];
  const batchTotal = batches.data?.total ?? batchRows.length;
  const batchHouses = batchRows.reduce((sum, row) => sum + row.houseCount, 0);
  const latestBatch = batchRows[0];

  const smsTotal = num(sms.data?.total ?? sms.data?.sent ?? sms.data?.count);
  const smsDelivered = num(sms.data?.delivered ?? sms.data?.deliveryCount ?? sms.data?.success);
  const smsRate = typeof sms.data?.deliveredRate === 'number' ? sms.data.deliveredRate : smsTotal ? Math.round((smsDelivered / smsTotal) * 1000) / 10 : null;

  const bracketView = brackets.data ? normalizeBrackets(brackets.data) : null;
  const screenData = normalizeScreenSummary(screenSummary.data);
  const screenTarget = screenData?.target ?? null;
  const screenToday = screenData?.today ?? null;
  const screenMonth = screenData?.monthToDate ?? null;
  const trendPoints = screenData?.trend ?? [];
  const communitiesRank = screenData?.communities ?? [];
  const allCommunityIds = communities.map((item) => item.id);
  const allCommunitiesSelected = selectedCommunities.length === 0 || (allCommunityIds.length > 0 && selectedCommunities.length === allCommunityIds.length);
  const selectedCommunityNames = communities.filter((item) => allCommunitiesSelected || selectedCommunities.includes(item.id)).map((item) => item.name);
  const communityLabel = selectedCommunities.length === 0
    ? '未选择'
    : allCommunitiesSelected
      ? '全部 ' + allCommunityIds.length + ' 个'
      : selectedCommunities.length === 1
        ? (selectedCommunityNames[0] || '1 个')
        : selectedCommunities.length + ' 个';
  useEffect(() => {
    if (!communityMenuOpen) return undefined;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (!communityMenuRef.current?.contains(event.target as Node)) setCommunityMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('touchstart', onPointer); };
  }, [communityMenuOpen]);
  const toggleCommunity = (id: number) => {
    setSelectedCommunities((prev) => {
      const current = prev.length ? prev : allCommunityIds;
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      return next.length ? next : allCommunityIds;
    });
  };
  const pickCommunityOnly = (id: number) => setSelectedCommunities([id]);
  const monthKeys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const monthBuckets = monthKeys.map((key) => {
    const rows = trendPoints.filter((point) => point.key.slice(0, 7) === key);
    return {
      key,
      label: key.slice(5),
      paidCents: key === today.slice(0, 7) && (screenMonth?.paidCents ?? 0) > 0 ? (screenMonth?.paidCents || 0) : rows.reduce((sum, point) => sum + point.paidCents, 0),
      targetCents: screenTarget?.hasTarget ? Math.round(screenTarget.annualCents / 12) : rows.reduce((sum, point) => sum + point.targetCents, 0),
      current: key === today.slice(0, 7),
    };
  });
  const chartPoints = granularity === 'month' && trendPoints.length && trendPoints[0].key.length >= 7
    ? (() => { let cp = 0; let ct = 0; return monthKeys.map((key) => { const bucket = monthBuckets.find((item) => item.key === key)!; cp += bucket.paidCents; ct += bucket.targetCents; return { key, label: key.slice(5), paidCents: bucket.paidCents, targetCents: bucket.targetCents, cumPaidCents: cp, cumTargetCents: ct }; }); })()
    : trendPoints;
  const arrearsView: ScreenArrears | null = screenData?.arrears ?? (bracketView ? { buckets: bracketView.buckets, totalCount: bracketView.total.count, totalAmountCents: bracketView.total.amountCents } : null);
  const todayNeed = screenToday?.dailyNeedCents || screenTarget?.dailyNeedCents || 0;
  const todayPct = screenToday?.vsDailyNeed !== undefined && screenToday?.vsDailyNeed !== null
    ? screenToday.vsDailyNeed
    : (screenToday && todayNeed > 0 ? (screenToday.paidCents / todayNeed) * 100 : null);
  const summaryError = screenSummary.error;
  const summaryLoading = screenSummary.loading;

  // 底部实时播报：近期缴费（MIS 只有日期精度，只显示 paidAt 的月-日）→ 今日实收 → 通知批次数 → 短信送达率 → 欠费小区。
  // 不把 recordedAt 当收款时间；需要时刻时只能写「登记 HH:mm」，本次不展示。
  const tickerMessages: { text: string; paid?: boolean }[] = [];
  if (year === currentYear) {
    const recentRows = recent.rows;
    for (const row of recentRows.slice(0, 10)) {
      if (!row.paidAt) continue;
      tickerMessages.push({ paid: true, text: [row.paidAt.slice(5), row.ownerName || '业主未登记', row.address, row.channel || '', '¥' + cents(row.amountCents)].filter(Boolean).join(' ') });
    }
  }
  if (year === currentYear && trend.data) {
    const todayRow = trend.data.rows.find((row) => row.day === today);
    const todayNet = Number(todayRow?.netCents) || 0;
    // 汇总项不挂「已收款」；今日 0 元直接跳过，避免出现「今日实收 ¥0.00 已收款」。
    if (todayNet > 0) tickerMessages.push({ text: '今日实收 ¥' + cents(todayNet) });
  }
  if (batches.data && batchTotal > 0) tickerMessages.push({ text: '本轮已通知 ' + batchTotal + ' 批 / ' + batchHouses + ' 户次' });
  if (smsRate !== null) tickerMessages.push({ text: '短信送达率 ' + smsRate + '%' + (smsTotal ? '（共 ' + smsTotal + ' 条）' : '') });
  const communityRows = communityData.data?.rows || [];
  if (communityRows.length) {
    const totalUnpaid = communityRows.reduce((sum, row) => sum + row.unpaidCents, 0);
    [...communityRows].sort((a, b) => b.unpaidCents - a.unpaidCents).slice(0, 3)
      .filter((row) => row.unpaidCents > 0)
      .forEach((row) => {
        const share = totalUnpaid ? Math.round((row.unpaidCents / totalUnpaid) * 1000) / 10 : 0;
        tickerMessages.push({ text: row.name + '待缴 ¥' + cents(row.unpaidCents) + '，占全部 ' + share + '%' });
      });
  }

  useEffect(() => { setTickerIndex(0); }, [signal]);
  useEffect(() => {
    if (!reduceMotion || tickerMessages.length < 2) return;
    const timer = window.setInterval(() => setTickerIndex((value) => (value + 1) % tickerMessages.length), 5500);
    return () => window.clearInterval(timer);
  }, [reduceMotion, tickerMessages.length]);

  return (
    <div className={"screen scr-v2" + (tickerMessages.length ? " has-ticker" : "")} data-page="screen">
      <ThreeBackdrop reducedMotion={reduceMotion} />
      <header className="scr-head">
        <div className="scr-brand">
          <span className="scr-mark" aria-hidden="true" />
          <div>
            <h1>收费与催缴看板</h1>
            
          </div>
        </div>
        <div className="scr-meta">
          <div className="scr-community-picker" ref={communityMenuRef}>
            <button type="button" className="scr-scope scr-picker-btn" aria-haspopup="true" aria-expanded={communityMenuOpen} onClick={() => setCommunityMenuOpen((value) => !value)} title={options.error || '勾选小区，全部图表一起刷新'}>
              <span>小区</span><b>{communityLabel}</b><i aria-hidden="true">▾</i>
            </button>
            {communityMenuOpen ? (
              <div className="scr-community-pop" role="dialog" aria-label="选择小区">
                <div className="scr-pop-head">
                  <button type="button" onClick={() => setSelectedCommunities(allCommunityIds)}>全选</button>
                  <button type="button" onClick={() => setSelectedCommunities([])}>清空</button>
                </div>
                {communities.length ? communities.map((item) => (
                  <label key={item.id} className="scr-pop-item">
                    <input type="checkbox" checked={allCommunitiesSelected || selectedCommunities.includes(item.id)} onChange={() => toggleCommunity(item.id)} />
                    <span>{item.name}</span>
                  </label>
                )) : <div className="scr-pop-empty">暂无小区</div>}
              </div>
            ) : null}
          </div>
          <label className="scr-scope" title="切换年度后重新读取该年度数据">
            <span>年度</span>
            <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="数据范围年度">
              {yearOptions.map((y) => <option key={y} value={y}>{y} 年</option>)}
            </select>
          </label>
          <span className="scr-updated" title={lastUpdatedClock ? '最后更新 ' + lastUpdatedClock : undefined}>每 5 分钟自动刷新{staleAsOf ? <em className="scr-updated-stale"> · 数据截至 {staleAsOf}</em> : null}</span>
          {loading && <span className="scr-live"><i />刷新中</span>}
          <button type="button" className="scr-btn" onClick={() => setTick((value) => value + 1)}>刷新</button>
          <button type="button" className="scr-btn" onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏'}</button>
          <button type="button" className="scr-btn ghost" onClick={() => navigate(firstAllowedPath(session.access) || '/fees')}>返回后台</button>
        </div>
      </header>

      <section className="scr-top" aria-label="年度达成与今日实时">
        <AnnualPanel target={screenTarget} year={year} loading={summaryLoading} error={summaryError} onSettings={() => navigate('/settings')} />
        <MonthPanel month={screenMonth} />
        <article className="scr-panel scr-today">
          <div className="scr-panel-head"><h2>今日实时</h2><span className="scr-legend">今日实收 · 日均需收完成度</span></div>
          {summaryError ? <NoData /> : !screenToday ? (summaryLoading ? <div className="scr-no-data">读取中…</div> : <NoData />) : (
            <div className="scr-today-body" key={screenSummary.loadedAt}>
              <div className="scr-today-main">
                <span className="scr-today-label">今日实收</span>
                <b className="scr-today-value scr-flash"><RollingCents value={screenToday.paidCents} /></b>
                <span className="scr-today-sub">{screenToday.count} 笔 · {screenToday.houses} 户</span>
              </div>
              <div className="scr-today-side">
                <TodayRing pct={todayPct} />
                <span>今日 / 日均需收</span>
              </div>
            </div>
          )}
        </article>
      </section>

      <section className="scr-main">
        <div className="scr-main-left">
          <article className="scr-panel scr-cum-panel">
            <div className="scr-panel-head">
              <h2>累计实收 vs 指标</h2>
              <span className="scr-legend">{screenTarget?.partial ? '实收累计 · 指标线仅已设指标小区' : '实收累计 · 指标累计'}</span>
              <div className="scr-gran">
                <button type="button" className={'scr-gran-btn' + (granularity === 'day' ? ' on' : '')} onClick={() => setGranularity('day')}>按日</button>
                <button type="button" className={'scr-gran-btn' + (granularity === 'month' ? ' on' : '')} onClick={() => setGranularity('month')}>按月</button>
              </div>
            </div>
            {summaryError ? <NoData /> : chartPoints.length ? <CumulativeChart points={chartPoints} year={Number(year)} granularity={granularity} annualTargetCents={screenTarget?.annualCents ?? 0} /> : <NoData />}
          </article>

          <article className="scr-panel scr-month-panel">
            <div className="scr-panel-head"><h2>月度实收 vs 指标</h2><span className="scr-legend">绿=达标 · 浅红=未达标 · 本月高亮{screenTarget?.partial ? ' · 指标线仅已设指标小区' : ''}</span></div>
            {summaryError || !trendPoints.length ? <NoData /> : <MonthlyChart months={monthBuckets} />}
          </article>

          <article className="scr-panel scr-aging-panel">
            <div className="scr-panel-head"><h2>欠费结构</h2><span className="scr-legend">按户待缴总额分档</span></div>
            {summaryError && !arrearsView ? <NoData /> : <ScreenArrearsBars arrears={arrearsView} />}
          </article>
        </div>

        <article className="scr-panel scr-ranking">
          <div className="scr-panel-head"><h2>小区达成率排行</h2><span className="scr-legend">点击只看该小区</span></div>
          {summaryError ? <NoData /> : <CommunityRanking rows={communitiesRank} selectedIds={selectedCommunities} onPick={pickCommunityOnly} />}
        </article>
      </section>

      {tickerMessages.length > 0 && (
        <footer className="scr-ticker" aria-label="实时播报">
          <span className="scr-ticker-label">实时播报</span>
          {reduceMotion ? (
            <div className="scr-ticker-static"><span key={tickerIndex}>{tickerMessages[tickerIndex % tickerMessages.length]?.text}{tickerMessages[tickerIndex % tickerMessages.length]?.paid ? <em className="scr-ticker-paid">已收款</em> : null}</span></div>
          ) : (
            <div className="scr-ticker-viewport">
              <div className="scr-ticker-track">
                {[...tickerMessages, ...tickerMessages].map((item, index) => <span key={index}>{item.text}{item.paid ? <em className="scr-ticker-paid">已收款</em> : null}</span>)}
              </div>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
