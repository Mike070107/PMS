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
  const signal = `${tick}|${activeOffice}|${community}|${year}`;

  const today = chinaDate();
  const communityId = community ? Number(community) : undefined;
  const yearMonths = year === currentYear
    ? Array.from({ length: Number(today.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const yearFrom = `${year}-01-01`;
  const yearTo = year === currentYear ? today : `${year}-12-31`;
  const yearOptions = Array.from({ length: 4 }, (_, i) => String(Number(currentYear) - i));

  const options = useLive<Options>('/fees/mis/options', {}, signal);
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

  const sync = offlineStatus(dash.data ?? options.data);
  const offlineMode = sync.offline;
  const quietEmpty = (text: string, detail?: string) => offlineMode
    ? <Empty text="MIS 同步中，稍后自动刷新" />
    : <Empty text={text} detail={detail} />;
  const summary = dash.data?.summary;
  const paidRate = summary && summary.receivableCents ? Math.round((summary.paidCents / summary.receivableCents) * 1000) / 10 : null;
  const unpaidShare = summary && summary.receivableCents ? Math.round((summary.unpaidCents / summary.receivableCents) * 1000) / 10 : null;
  const loadedAt = Math.max(dash.loadedAt, trend.loadedAt, brackets.loadedAt, batches.loadedAt, effect.loadedAt, sms.loadedAt, recent.loadedAt);
  const loading = [dash, trend, brackets, batches, effect, sms, recent].some((item) => item.loading);

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
  const communities = options.data?.communities || [];

  const bracketView = brackets.data ? normalizeBrackets(brackets.data) : null;

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
    <div className={"screen" + (tickerMessages.length ? " has-ticker" : "")} data-page="screen">
      <header className="scr-head">
        <div className="scr-brand">
          <span className="scr-mark" aria-hidden="true" />
          <div>
            <h1>收费与催缴看板</h1>
            <p>住宅收费 · 一通MIS · 只读账务 · 1920×1080 投屏</p>
          </div>
        </div>
        <div className="scr-meta">
          <label className="scr-scope" title={options.error || '按当前管理处授权范围筛选'}>
            <span>小区</span>
            <select value={community} onChange={(e) => setCommunity(e.target.value)} aria-label="数据范围小区">
              <option value="">全部授权小区</option>
              {communities.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          </label>
          <label className="scr-scope" title="切换年度后重新读取该年度数据">
            <span>年度</span>
            <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="数据范围年度">
              {yearOptions.map((y) => <option key={y} value={y}>{y} 年</option>)}
            </select>
          </label>
          <span className="scr-updated">最后更新 {loadedAt ? new Date(loadedAt).toLocaleString('zh-CN', { hour12: false }) : '读取中…'}</span>
          {offlineMode && sync.asOf ? <span className="scr-asof" style={sync.stale ? { color: 'var(--warn)', fontWeight: 700 } : undefined}>数据截至 {sync.asOf}（MIS 同步{sync.stale ? ' · 已滞后' : ''}）</span> : null}
          {loading && <span className="scr-live"><i />刷新中</span>}
          <button type="button" className="scr-btn" onClick={() => setTick((value) => value + 1)}>刷新</button>
          <button type="button" className="scr-btn" onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏'}</button>
          <button type="button" className="scr-btn ghost" onClick={() => navigate(firstAllowedPath(session.access) || '/fees')}>返回后台</button>
        </div>
      </header>

      <section className="scr-kpis" aria-label="本期收费指标">
        {dash.error && !summary ? (
          offlineMode ? <div className="scr-panel scr-kpi"><Empty text="MIS 同步中，稍后自动刷新" /></div> : <div className="scr-panel scr-kpi err"><Empty text="MIS 指标读取失败" detail={dash.error} /></div>
        ) : (
          <>
            <article className="scr-panel scr-kpi">
              <span className="scr-kpi-label">本期应收</span>
              <b className="scr-kpi-value due">¥{cents(summary?.receivableCents || 0)}</b>
              <span className="scr-kpi-sub">{year} 年非退款账单</span>
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
            <h2>{year} 年按月收缴趋势</h2>
            <span className="scr-legend">实收净额 · 按月{community ? ' · ' + (communities.find((c) => String(c.id) === community)?.name || '所选小区') : ' · 全部授权小区'}</span>
          </div>
          {trend.error ? quietEmpty("趋势读取失败", trend.error) : trend.data ? <TrendChart buckets={monthly} /> : <Empty text="正在读取趋势…" />}
        </article>

        <article className="scr-panel scr-aging-panel">
          <div className="scr-panel-head">
            <h2>待缴金额分布</h2>
            <span className="scr-legend">按户待缴总额分档</span>
          </div>
          {brackets.error ? quietEmpty("待缴金额读取失败", brackets.error) : bracketView ? (
            <AmountBars buckets={bracketView.buckets} totalAmount={bracketView.total.amountCents} totalCount={bracketView.total.count} />
          ) : <Empty text="正在读取待缴金额…" />}
        </article>
      </section>

      <section className="scr-bottom" aria-label="催缴成效">
        <article className="scr-panel scr-mini">
          <div className="scr-panel-head"><h2>本轮催缴批次与户数</h2><span className="scr-legend">最近 100 批</span></div>
          {batches.error ? quietEmpty("催缴批次读取失败", batches.error) : (
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
            effect.loading ? <Empty text="正在核对 T+30 回款…" /> : offlineMode ? <Empty text="MIS 同步中，稍后自动刷新" /> : <Empty text="T+30 回款暂不可用" todo detail={effect.error || undefined} />
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
          {sms.error ? quietEmpty("短信送达率暂不可用", sms.error) : sms.data ? (
            <div className="scr-mini-body">
              <div><b>{smsRate === null ? '—' : smsRate + '%'}</b><small>送达率</small></div>
              <div><b>{smsDelivered || '—'}</b><small>已送达</small></div>
              <span className="scr-mini-note">共 {smsTotal || '—'} 条 · 数据来自短信发送记录</span>
            </div>
          ) : <Empty text="正在读取短信送达…" />}
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
