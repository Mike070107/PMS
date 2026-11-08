import { Fragment, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { request } from '@pms/api-client';
import { logObjectLabel, safeLogTechnical, type LogPresentation } from '@/lib/logs-presentation';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';
import {useSession} from '@/lib/auth';
import {can} from '@/lib/perm';
import './Logs.css';

interface Overview {
  periodHours: number;
  summary: { requests: number; errors: number; slowRequests: number; avgDurationMs: number; maxDurationMs: number; activeUsers: number };
  logCounts: Record<string, number>;
  runtime: { status: 'healthy' | 'unhealthy'; dbStatus: 'up' | 'down'; dbLatencyMs: number; uptimeSeconds: number; processRssMb: number; serverFreeMemoryMb: number; serverTotalMemoryMb: number };
}
interface LogRow {
  presentation?: LogPresentation | null;
  id: number; category: string; level: string; source: string; action: string; success: boolean; actorName: string;
  requestMethod?: string | null; requestPath?: string | null; statusCode?: number | null; durationMs?: number | null; message: string; createdAt: string;
}
interface LogList { list: LogRow[]; total: number; page: number; pageSize: number }
interface IntroViewRow {
  id: number;
  viewedAt: string;
  ip: string | null;
  path: string | null;
  userAgent: string | null;
  referrer: string | null;
  entry: string | null;
}
interface IntroViews {
  summary: { total: number; today: number; uniqueIps: number; lastViewedAt: string | null };
  daily: Array<{ date: string; count: number }>;
  list: IntroViewRow[];
  total: number;
  page: number;
  pageSize: number;
}

const CATS: Array<{ k: string; n: string; icon: IconName; tone: string }> = [
  { k: '', n: '全部', icon: 'log', tone: 'blue' },
  { k: 'operation', n: '业务操作', icon: 'check', tone: 'blue' },
  { k: 'login', n: '登录', icon: 'users', tone: 'green' },
  { k: 'error', n: '自动异常', icon: 'alert', tone: 'red' },
  { k: 'alert', n: '系统告警', icon: 'alert', tone: 'red' },
];
const SRC: Record<string, string> = { 'admin-web': '管理后台', 'neighbor-web': '新版后台', 'miniapp-staff': '员工端', 'miniapp-owner': '业主端', miniapp: '小程序' };
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} 天` : `${Math.floor(s / 3600)} 小时`);

/**
 * 日志（beta 新建）：上方看系统是否健康（库、内存、24h 错误/慢请求），下方按类别查谁在什么时候做了什么。
 * 走 /observability/overview、/observability/logs；只读审计展示，不修改历史数据。
 */
export default function Logs() {
  const session = useSession();
  const canView = can('logs', 'view');
  const scopeKey = JSON.stringify([session.user?.id,session.user?.tenantId,session.actingTenant?.id,session.actingOffice?.id]);
  const [tab, setTab] = useState<'logs' | 'intro' | 'usage' | 'feedback'>('logs');
  const [ov, setOv] = useState<Overview | null>(null);
  const [cat, setCat] = useState('');
  const [onlyFail, setOnlyFail] = useState(false);
  const [kw, setKw] = useState('');
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<LogList | null>(null);
  const [auditClass, setAuditClass] = useState('');
  const [logError, setLogError] = useState(false);
  const [overviewError, setOverviewError] = useState(false);
  const [retryLogs, setRetryLogs] = useState(0);
  const [retryOverview, setRetryOverview] = useState(0);
  const [retryIntro, setRetryIntro] = useState(0);

  useEffect(() => {
    if(!canView) return;
    let current = true;
    setOv(null);
    setOverviewError(false);
    request<Overview>({url:'/observability/overview'}).then(r=>{if(current)setOv(r);}).catch(()=>{if(current)setOverviewError(true);});
    return () => {current = false;};
  }, [canView, scopeKey, retryOverview]);
  useEffect(() => {
    if(!canView) return;
    let current = true;
    setLogs(null);
    setLogError(false);
    const t = setTimeout(() => {
      request<LogList>({ url: '/observability/logs', query: { page, pageSize: 30, category: cat || undefined, auditClass: auditClass || undefined, success: onlyFail ? false : undefined, keyword: kw.trim() || undefined } })
        .then(r=>{if(current)setLogs(r);}).catch(()=>{if(current)setLogError(true);});
    }, kw ? 350 : 0);
    return () => {current=false;clearTimeout(t);};
  }, [cat, auditClass, onlyFail, kw, page, canView, scopeKey, retryLogs]);

  if(!canView) return <div className="card" role="alert" style={{padding:32}}><h1>无权访问日志管理</h1><p>当前账号没有日志管理的查看权限。</p></div>;

  const pages = logs ? Math.max(1, Math.ceil(logs.total / logs.pageSize)) : 1;
  const rt = ov?.runtime;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="logs" /><h1 style={{ fontSize: 22 }}>日志</h1></div><p>系统运行状况与操作记录 · 汇报页访问</p></div>
        <div className="act">
          <a className="btn sm" href="/intro/" target="_blank" rel="noopener" style={{marginRight:10}}><Icon name="link" size={15} />打开汇报页</a>
          <button className="btn" onClick={() => {setRetryLogs(v=>v+1);setRetryOverview(v=>v+1);setRetryIntro(v=>v+1);}}>刷新</button>
        </div>
      </div>

      <div className="chips" style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist" aria-label="日志视图">
        <button role="tab" aria-selected={tab === 'logs'} className={`chip ${tab === 'logs' ? 'on' : ''}`} onClick={() => setTab('logs')}><Icon name="log" size={14} />系统日志</button>
        <button role="tab" aria-selected={tab === 'intro'} className={`chip ${tab === 'intro' ? 'on' : ''}`} onClick={() => setTab('intro')}><Icon name="globe" size={14} />汇报页访问</button>
        <button role="tab" aria-selected={tab === 'usage'} className={`chip ${tab === 'usage' ? 'on' : ''}`} onClick={() => setTab('usage')}><Icon name="chart" size={14} />使用统计</button>
        <button role="tab" aria-selected={tab === 'feedback'} className={`chip ${tab === 'feedback' ? 'on' : ''}`} onClick={() => setTab('feedback')}><Icon name="bell" size={14} />用户反馈</button>
      </div>

      {tab === 'logs' ? (<>
      {overviewError ? <div className="card" role="alert" style={{padding:16,marginBottom:16}}>运行概览加载失败，统计未获取。<button className="btn sm" onClick={()=>setRetryOverview(v=>v+1)}>重试概览</button></div> : null}
      {ov && rt ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div className="stat"><div className={`ic ${rt.status === 'healthy' ? 'green' : 'red'}`}><Icon name={rt.status === 'healthy' ? 'check' : 'alert'} /></div><div className="v" style={{ fontSize: 18 }}>{rt.status === 'healthy' ? '运行正常' : '有异常'}</div><div className="k">已运行 {uptime(rt.uptimeSeconds)}</div></div>
          <div className="stat"><div className={`ic ${rt.dbStatus === 'up' ? 'green' : 'red'}`}><Icon name="gear" /></div><div className="v" style={{ fontSize: 18 }}>{rt.dbStatus === 'up' ? `${rt.dbLatencyMs} ms` : '断开'}</div><div className="k">数据库</div></div>
          <div className="stat"><div className="ic blue"><Icon name="chart" /></div><div className="v" style={{ fontSize: 18 }}>{ov.summary.requests.toLocaleString()}</div><div className="k">{ov.periodHours}h 请求 · {ov.summary.activeUsers} 人在用</div></div>
          <div className="stat"><div className={`ic ${ov.summary.errors ? 'red' : 'green'}`}><Icon name="alert" /></div><div className="v" style={{ fontSize: 18 }}>{ov.summary.errors}</div><div className="k">{ov.periodHours}h 出错</div></div>
          <div className="stat"><div className={`ic ${ov.summary.slowRequests ? 'amber' : 'green'}`}><Icon name="clock" /></div><div className="v" style={{ fontSize: 18 }}>{ov.summary.slowRequests}</div><div className="k">慢请求 · 平均 {ov.summary.avgDurationMs} ms</div></div>
          <div className="stat"><div className="ic blue"><Icon name="gear" /></div><div className="v" style={{ fontSize: 18 }}>{Math.round((1 - rt.serverFreeMemoryMb / Math.max(1, rt.serverTotalMemoryMb)) * 100)}%</div><div className="k">服务器内存占用</div></div>
        </div>
      ) : null}

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips">{CATS.map((c) => (
          <button key={c.k} className={`chip ${cat === c.k ? 'on' : ''}`} onClick={() => { setCat(c.k); setAuditClass(''); setPage(1); }}>
            <Icon name={c.icon} size={14} />{c.n}{c.k && ov?.logCounts?.[c.k] ? ` ${ov.logCounts[c.k]}` : ''}
          </button>
        ))}</div>
        <button className={`chip ${onlyFail ? 'on' : ''}`} onClick={() => { setOnlyFail(!onlyFail); setPage(1); }}>只看失败</button>
        <input className="in" style={{ width: 240, maxWidth:'100%', marginLeft: 'auto' }} value={kw} placeholder="搜内容 / 动作代码 / 路径" onChange={(e) => { setKw(e.target.value); setPage(1); }} />
      </div>

      <div className="chips" style={{margin:'12px 0',display:'flex',gap:8,flexWrap:'wrap'}} aria-label="关键审计分类">
        {[['','全部审计'],['approval','审批记录'],['archive_delete','归档 / 删除'],['permission','权限变更']].map(([key,label])=><button key={key} className={`chip ${auditClass===key?'on':''}`} onClick={()=>{setAuditClass(key);setCat(key?'operation':'');setPage(1);}}>{label}</button>)}
      </div>
      {logError ? <div className="card" role="alert" style={{padding:24}}>日志加载失败，总数未获取；筛选条件已保留。<button className="btn" onClick={()=>setRetryLogs(v=>v+1)}>重试日志</button></div> : logs === null ? <Loading /> : logs.list.length === 0 ? <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="muted">没有匹配的记录</span></div> : (
        <div className="card logs-list" style={{ overflow: 'hidden' }}>
          <div className="rowList">
            {logs.list.map((l) => {
              const meta = CATS.find((c) => c.k === l.category) || CATS[0];
              const technical = safeLogTechnical(l);
              return (
                <div key={l.id} className="lrow">
                  <div className={`li ic ${l.success ? meta.tone : 'red'}`}><Icon name={l.success ? meta.icon : 'alert'} /></div>
                  <div className="lt">
                    <b style={{ fontWeight: 600 }}>{l.presentation?.actionLabel || (l.category==='operation'?'业务操作（展示信息未获取）':technical.message || technical.action)}</b>
                    <small>{l.actorName || '系统'} · {SRC[l.source] || l.source}{l.presentation ? ` · ${l.presentation.moduleLabel} · ${logObjectLabel(l.presentation)}` : ''}</small>
                    <div style={{margin:'6px 0'}}><span className={`tag ${l.success?'ok':'dang'}`}>{l.presentation?.requestResult || (l.success?'请求成功':'请求失败')}</span>{l.presentation?.businessResult ? <span className="tag" style={{marginLeft:8}}>审批结果：{l.presentation.businessResult}</span> : null}</div>
                    <details style={{fontSize:14,overflowWrap:'anywhere'}}><summary style={{cursor:'pointer'}}>查看审计详情</summary>
                      {l.presentation ? <><p>{l.presentation.historyNotice}</p><p>{l.presentation.completionNotice}</p></> : null}
                      <p>技术请求：{l.requestMethod || '—'} {technical.path} · HTTP {l.statusCode ?? '未记录'} · {l.durationMs != null ? `${l.durationMs}ms` : '耗时未记录'}</p>
                      <p>动作代码：{technical.action} · 日志 #{l.id}</p>
                    </details>
                  </div>
                  <span className="muted log-time" style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{dayjs(l.createdAt).format('YYYY-MM-DD HH:mm:ss')}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {logs && logs.total > logs.pageSize ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 14 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted">第 {page} / {pages} 页 · 共 {logs.total} 条</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      ) : null}
      </>) : tab === 'intro' ? (
        <IntroViewsPanel retry={retryIntro} />
      ) : tab === 'usage' ? (
        <UsagePanel scopeKey={scopeKey} />
      ) : (
        <FeedbackPanel scopeKey={scopeKey} />
      )}
    </>
  );
}

/** 汇报页访问：公开页 /intro/ 的打开次数、时间、来源 IP；只读展示，不改历史数据 */
function IntroViewsPanel({ retry }: { retry: number }) {
  const [data, setData] = useState<IntroViews | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const [localRetry, setLocalRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    request<IntroViews>({ url: '/observability/intro-views', query: { page, pageSize: 20, days: 7 } })
      .then((r) => { if (alive) setData(r); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [page, retry, localRetry]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const max = Math.max(1, ...(data?.daily || []).map((d) => d.count));
  const last = data?.summary.lastViewedAt ? dayjs(data.summary.lastViewedAt).format('MM-DD HH:mm') : '—';
  const device = (ua: string | null) => {
    if (!ua) return '—';
    const phone = /Mobile|Android|iPhone|MicroMessenger/i.test(ua);
    const browser = /MicroMessenger/i.test(ua) ? '微信' : /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : /Firefox\//i.test(ua) ? 'Firefox' : '浏览器';
    return `${phone ? '手机' : '电脑'} · ${browser}`;
  };
  if (error) return <div className="card" role="alert" style={{ padding: 24 }}>汇报页访问统计加载失败。<button className="btn" style={{marginLeft:12}} onClick={() => setLocalRetry(v => v + 1)}>重试</button></div>;
  if (!data) return <Loading />;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="stat"><div className="ic blue"><Icon name="chart" /></div><div className="v" style={{ fontSize: 26 }}>{data.summary.total.toLocaleString()}</div><div className="k">累计打开次数</div></div>
        <div className="stat"><div className="ic green"><Icon name="today" /></div><div className="v" style={{ fontSize: 26 }}>{data.summary.today.toLocaleString()}</div><div className="k">今日打开</div></div>
        <div className="stat"><div className="ic blue"><Icon name="globe" /></div><div className="v" style={{ fontSize: 26 }}>{data.summary.uniqueIps.toLocaleString()}</div><div className="k">独立来源 IP</div></div>
        <div className="stat"><div className="ic amber"><Icon name="clock" /></div><div className="v" style={{ fontSize: 20 }}>{last}</div><div className="k">最近打开时间</div></div>
      </div>

      <div className="card intro-chart">
        <div className="intro-chart-head"><b>最近 7 天打开趋势</b><span className="muted">按北京时间自然日 · 同 IP 2 秒内只记一次</span></div>
        <div className="intro-bars">
          {data.daily.map((d) => (
            <div className="intro-bar" key={d.date} title={`${d.date} · ${d.count} 次`}>
              <span style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }} className={d.count ? '' : 'empty'} />
              <small>{d.date.slice(5)}</small>
              <b>{d.count}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
        <div className="intro-list-head"><b>打开明细</b><span className="muted">共 {data.total} 条 · 保留最近 180 天</span></div>
        {data.list.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="muted">还没有打开记录。把 /intro/ 链接发给同事后，这里会显示打开时间与来源 IP。</div> : (
          <div className="intro-table-wrap">
            <table className="t intro-table">
              <thead><tr><th>打开时间</th><th>来源 IP</th><th>入口</th><th>来源页面</th><th>设备</th></tr></thead>
              <tbody>
                {data.list.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dayjs(row.viewedAt).format('YYYY-MM-DD HH:mm:ss')}</td>
                    <td className="intro-ip">{row.ip || '—'}</td>
                    <td>{row.entry || '直接打开'}</td>
                    <td className="intro-referrer" title={row.referrer || undefined}>{row.referrer || '—'}</td>
                    <td>{device(row.userAgent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.total > data.pageSize ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 14 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted">第 {page} / {pages} 页 · 共 {data.total} 条</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      ) : null}
      <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>统计口径：每次打开 /intro/ 页面记一次（同一 IP 2 秒内去重）；IP 由服务端从请求头获取，仅用于内部访问统计。</p>
    </>
  );
}

/** 使用统计：page-usage + login-history；接口未就绪时显示「待接口」，不造假数据。 */
type UsageDay = { date: string; count: number };
type UsagePageRow = { name: string; path?: string; views: number; users: number; share: number };
type UsageUserRow = { name: string; userId?: string; views: number; pages: number; topPage: string };
type UsageData = { totalViews: number; uniqueUsers: number; days: UsageDay[]; topPages: UsagePageRow[]; topUsers: UsageUserRow[] };
type LoginRow = { id: string; time: string; user: string; method: string; status: 'success' | 'failed' | 'unknown'; reason: string; ip: string };
type LoginData = { rows: LoginRow[]; total: number };
type LoginFilter = 'all' | 'success' | 'failed';

function numberValue(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
function normalizeUsage(raw: any): UsageData {
  const totalViews = numberValue(raw?.totalViews ?? raw?.views ?? raw?.total);
  const uniqueUsers = numberValue(raw?.uniqueUsers ?? raw?.users ?? raw?.userCount);
  const days = Array.isArray(raw?.days) ? raw.days.map((row: any) => ({ date: textValue(row?.date, row?.day, row?.bucket).slice(0, 10), count: numberValue(row?.count ?? row?.views ?? row?.visits) })) : [];
  const topPages = Array.isArray(raw?.topPages) ? raw.topPages.map((row: any) => {
    const views = numberValue(row?.views ?? row?.count ?? row?.visits);
    const shareRaw = Number(row?.share ?? row?.ratio);
    const share = Number.isFinite(shareRaw) && shareRaw > 0 ? (shareRaw <= 1 ? shareRaw * 100 : shareRaw) : (totalViews ? (views / totalViews) * 100 : 0);
    return { name: textValue(row?.name, row?.pageName, row?.path, row?.pageKey) || '未命名页面', path: textValue(row?.path, row?.pagePath, row?.pageKey, row?.name) || undefined, views, users: numberValue(row?.uniqueUsers ?? row?.users ?? row?.userCount), share: Math.round(share * 10) / 10 };
  }) : [];
  const topUsers = Array.isArray(raw?.topUsers) ? raw.topUsers.map((row: any) => ({
    name: textValue(row?.name, row?.userName, row?.user, row?.loginAccount) || (row?.userId ? '用户 #' + row.userId : '未知用户'),
    userId: textValue(row?.userId, row?.id) || undefined,
    views: numberValue(row?.views ?? row?.count ?? row?.visits),
    pages: numberValue(row?.pages ?? row?.pageCount ?? row?.uniquePages),
    topPage: textValue(row?.topPage, row?.topPageName, row?.page, row?.mostVisitedPage) || '—',
  })) : [];
  return { totalViews, uniqueUsers, days, topPages, topUsers };
}
function normalizeLogin(raw: any): LoginData {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.list) ? raw.list : [];
  const rows = list.map((row: any, index: number) => {
    const statusRaw = String(row?.status ?? row?.result ?? '').toLowerCase();
    const success = row?.success === true || ['success', 'succeeded', 'ok', '1', 'true'].includes(statusRaw);
    const failed = row?.success === false || ['failed', 'failure', 'fail', 'error', '0', 'false'].includes(statusRaw);
    return {
      id: textValue(row?.id) || String(index),
      time: textValue(row?.time, row?.createdAt, row?.at, row?.loginAt),
      user: textValue(row?.userName, row?.name, row?.user, row?.account, row?.loginAccount, row?.attemptedAccount) || '未知用户',
      method: textValue(row?.method, row?.loginMethod, row?.provider, row?.type),
      status: success ? 'success' as const : failed ? 'failed' as const : 'unknown' as const,
      reason: textValue(row?.reason, row?.failureReason, row?.message),
      ip: textValue(row?.ip, row?.ipAddress, row?.clientIp) || '—',
    };
  });
  return { rows, total: numberValue(Array.isArray(raw) ? rows.length : raw?.total ?? rows.length) };
}
const LOGIN_METHOD: Record<string, string> = { password: '密码', wechat: '微信', qr: '扫码', oauth: '第三方', sso: '单点登录', token: '令牌' };

function UsagePanel({ scopeKey }: { scopeKey: string }) {
  const [windowKey, setWindowKey] = useState<'today' | '7d' | '30d' | 'custom'>('7d');
  const [from, setFrom] = useState(dayjs().subtract(6, 'day').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageMissing, setUsageMissing] = useState(false);
  const [login, setLogin] = useState<LoginData | null>(null);
  const [loginMissing, setLoginMissing] = useState(false);
  const [loginFilter, setLoginFilter] = useState<LoginFilter>('all');
  const [loginPage, setLoginPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  const chooseWindow = (key: 'today' | '7d' | '30d' | 'custom') => {
    setWindowKey(key);
    setLoginPage(1);
    if (key === 'custom') return;
    const days = key === 'today' ? 1 : key === '7d' ? 7 : 30;
    setFrom(dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD'));
    setTo(dayjs().format('YYYY-MM-DD'));
  };

  useEffect(() => {
    if (!from || !to || from > to) return;
    let alive = true;
    setUsage(null);
    setUsageMissing(false);
    request<unknown>({ url: '/telemetry/page-usage', query: { from, to } })
      .then((raw) => { if (alive) setUsage(normalizeUsage(raw)); })
      .catch(() => { if (alive) setUsageMissing(true); });
    return () => { alive = false; };
  }, [from, to, scopeKey, retry]);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let alive = true;
    setLogin(null);
    setLoginMissing(false);
    request<unknown>({ url: '/telemetry/login-history', query: { from, to, limit: 20, page: loginPage, status: loginFilter === 'all' ? undefined : loginFilter } })
      .then((raw) => { if (alive) setLogin(normalizeLogin(raw)); })
      .catch(() => { if (alive) setLoginMissing(true); });
    return () => { alive = false; };
  }, [from, to, loginPage, loginFilter, scopeKey, retry]);

  const invalidRange = !!from && !!to && from > to;
  const perUser = usage && usage.uniqueUsers ? Math.round((usage.totalViews / usage.uniqueUsers) * 10) / 10 : null;
  const trend = (usage?.days || []).slice(-trendDays);
  const trendMax = Math.max(1, ...trend.map((d) => d.count));
  const visibleLogin = (login?.rows || []).filter((row) => loginFilter === 'all' || row.status === loginFilter);
  const loginPages = login ? Math.max(1, Math.ceil(login.total / 20)) : 1;

  return (
    <>
      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="chips" role="tablist" aria-label="使用统计时间窗">
          {([['today', '今日'], ['7d', '近7天'], ['30d', '近30天'], ['custom', '自定义']] as const).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={windowKey === key} className={`chip ${windowKey === key ? 'on' : ''}`} onClick={() => chooseWindow(key)}>{label}</button>
          ))}
        </div>
        <input className="in" type="date" style={{ width: 150 }} value={from} max={to} aria-label="使用统计开始日期" onChange={(e) => { setWindowKey('custom'); setFrom(e.target.value); setLoginPage(1); }} />
        <span className="muted">至</span>
        <input className="in" type="date" style={{ width: 150 }} value={to} min={from} aria-label="使用统计结束日期" onChange={(e) => { setWindowKey('custom'); setTo(e.target.value); setLoginPage(1); }} />
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setRetry((value) => value + 1)}>刷新统计</button>
      </div>

      {invalidRange ? <div className="card" role="alert" style={{ padding: 24 }}>开始日期不能晚于结束日期。</div> : (
        <>
          {usageMissing ? (
            <div className="card usage-missing" role="status">
              <span className="usage-tag">待接口</span>
              <b>使用统计接口未就绪</b>
              <small>GET /telemetry/page-usage 暂不可用；接口上线后这里会显示总访问、独立用户、访问趋势与页面/用户榜单。</small>
              <button className="btn sm" onClick={() => setRetry((value) => value + 1)}>重试</button>
            </div>
          ) : usage === null ? <Loading /> : (
            <>
              <div className="usage-cards">
                <div className="stat"><div className="ic blue"><Icon name="chart" /></div><div className="v">{usage.totalViews.toLocaleString()}</div><div className="k">总访问次数</div></div>
                <div className="stat"><div className="ic green"><Icon name="users" /></div><div className="v">{usage.uniqueUsers.toLocaleString()}</div><div className="k">独立用户</div></div>
                <div className="stat"><div className="ic amber"><Icon name="today" /></div><div className="v">{perUser === null ? '—' : perUser}</div><div className="k">人均访问页数</div></div>
              </div>

              <div className="card intro-chart" style={{ marginBottom: 16 }}>
                <div className="intro-chart-head">
                  <b>访问趋势 · 按北京时间自然日</b>
                  <div className="chips">
                    {([[7, '近7天'], [30, '近30天']] as const).map(([days, label]) => (
                      <button key={days} className={`chip ${trendDays === days ? 'on' : ''}`} onClick={() => setTrendDays(days)}>{label}</button>
                    ))}
                  </div>
                </div>
                {trend.length === 0 ? <div className="muted" style={{ padding: '24px 0' }}>所选时间窗内没有访问记录。</div> : (
                  <div className="intro-bars">
                    {trend.map((d) => (
                      <div className="intro-bar" key={d.date || String(d.count)} title={`${d.date || '未标注日期'} · ${d.count} 次`}>
                        <b>{d.count}</b>
                        <span style={{ height: `${Math.max(3, (d.count / trendMax) * 100)}%` }} className={d.count ? '' : 'empty'} />
                        <small>{(d.date || '').slice(5) || '—'}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="usage-grid">
                <div className="card" style={{ overflow: 'hidden' }}>
                  <div className="intro-list-head"><b>页面 Top20</b><span className="muted">按访问次数 · 占比按总访问</span></div>
                  <div className="intro-table-wrap">
                    <table className="t usage-table">
                      <thead><tr><th>页面</th><th className="usage-num">访问次数</th><th className="usage-num">独立用户</th><th>占比</th></tr></thead>
                      <tbody>
                        {usage.topPages.map((row, index) => (
                          <tr key={row.name + index}>
                            <td>{row.name}</td>
                            <td className="usage-num"><button type="button" className="usage-link" title="查看该页面的访问明细" onClick={() => setDrill({ kind: 'page-events', title: '页面访问明细', subtitle: `时间窗 ${from} 至 ${to} · ${row.name}`, path: row.path || row.name })}>{row.views.toLocaleString()}</button></td>
                            <td className="usage-num"><button type="button" className="usage-link" title="查看该页面的用户列表" onClick={() => setDrill({ kind: 'page-users', title: '页面用户列表', subtitle: `时间窗 ${from} 至 ${to} · ${row.name}`, path: row.path || row.name })}>{row.users.toLocaleString()}</button></td>
                            <td><div className="usage-share"><i style={{ width: `${Math.min(100, Math.max(0, row.share))}%` }} /><span>{row.share}%</span></div></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {usage.topPages.length === 0 ? <div className="muted" style={{ padding: 32, textAlign: 'center' }}>所选时间窗内没有页面访问。</div> : null}
                  </div>
                </div>

                <div className="card" style={{ overflow: 'hidden' }}>
                  <div className="intro-list-head"><b>用户 Top20</b><span className="muted">按访问次数</span></div>
                  <div className="intro-table-wrap">
                    <table className="t usage-table">
                      <thead><tr><th>姓名</th><th className="usage-num">访问次数</th><th className="usage-num">页面数</th><th>最常访问页</th></tr></thead>
                      <tbody>
                        {usage.topUsers.map((row, index) => (
                          <tr key={row.name + index}>
                            <td>{row.name}</td>
                            <td className="usage-num"><button type="button" className="usage-link" title="查看该用户的访问明细" onClick={() => setDrill({ kind: 'user-events', title: '用户访问明细', subtitle: `时间窗 ${from} 至 ${to} · ${row.name}`, userId: row.userId })}>{row.views.toLocaleString()}</button></td>
                            <td className="usage-num"><button type="button" className="usage-link" title="查看该用户访问过的页面" onClick={() => setDrill({ kind: 'user-pages', title: '用户访问页面', subtitle: `时间窗 ${from} 至 ${to} · ${row.name}`, userId: row.userId })}>{row.pages.toLocaleString()}</button></td>
                            <td>{row.topPage}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {usage.topUsers.length === 0 ? <div className="muted" style={{ padding: 32, textAlign: 'center' }}>所选时间窗内没有用户访问。</div> : null}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
            <div className="intro-list-head">
              <b>登录记录</b>
              <div className="chips">
                {([['all', '全部'], ['success', '仅成功'], ['failed', '仅失败']] as const).map(([key, label]) => (
                  <button key={key} className={`chip ${loginFilter === key ? 'on' : ''}`} onClick={() => { setLoginFilter(key); setLoginPage(1); }}>{label}</button>
                ))}
              </div>
            </div>
            {loginMissing ? (
              <div className="usage-missing usage-missing-inline" role="status">
                <span className="usage-tag">待接口</span>
                <b>登录记录接口未就绪</b>
                <small>GET /telemetry/login-history 暂不可用；接口上线后这里显示登录时间、用户或尝试账号、方式、结果与 IP，并支持分页。</small>
                <button className="btn sm" onClick={() => setRetry((value) => value + 1)}>重试</button>
              </div>
            ) : login === null ? <div style={{ padding: 32 }}><Loading /></div> : (
              <>
                <div className="intro-table-wrap">
                  <table className="t usage-table">
                    <thead><tr><th>时间</th><th>用户 / 尝试账号</th><th>方式</th><th>结果</th><th>IP</th></tr></thead>
                    <tbody>
                      {visibleLogin.map((row) => (
                        <tr key={row.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{row.time ? dayjs(row.time).format('YYYY-MM-DD HH:mm:ss') : '—'}</td>
                          <td>{row.user}</td>
                          <td>{LOGIN_METHOD[row.method] || row.method || '—'}</td>
                          <td>{row.status === 'success' ? <span className="tag ok">成功</span> : row.status === 'failed' ? <span className="tag dang" title={row.reason || undefined}>失败{row.reason ? ' · ' + row.reason : ''}</span> : <span className="tag">未知</span>}</td>
                          <td className="intro-ip">{row.ip}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visibleLogin.length === 0 ? <div className="muted" style={{ padding: 32, textAlign: 'center' }}>所选筛选范围内没有登录记录。</div> : null}
                </div>
                {login.total > 20 ? (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', padding: 14, borderTop: '1px solid var(--line2)' }}>
                    <button className="btn sm" disabled={loginPage <= 1} onClick={() => setLoginPage((value) => value - 1)}>上一页</button>
                    <span className="muted">第 {loginPage} / {loginPages} 页 · 共 {login.total} 条</span>
                    <button className="btn sm" disabled={loginPage >= loginPages} onClick={() => setLoginPage((value) => value + 1)}>下一页</button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
      {drill ? <UsageDrilldown target={drill} from={from} to={to} onClose={() => setDrill(null)} /> : null}
    </>
  );
}

/* ───────────── 用户反馈（合并原「异常反馈」） ───────────── */
interface FeedbackRow {
  id: number | string;
  attachments?: Array<{ url?: string; name?: string | null }> | null;
  type?: string | null;
  kind?: string | null;
  userName?: string | null;
  userPhone?: string | null;
  createdAt?: string | null;
  time?: string | null;
  content?: string | null;
  attachmentUrls?: string[] | null;
  imageUrls?: string[] | null;
  source?: string | null;
  status?: string | null;
  origin?: 'unified' | 'legacy' | string | null;
  handledByName?: string | null;
  handledAt?: string | null;
  resolvedByName?: string | null;
  resolvedAt?: string | null;
  processorName?: string | null;
  context?: { page?: string; userAgent?: string; recentErrors?: Array<{ at?: string; message?: string; page?: string }> } | null;
  recentErrors?: Array<{ at?: string; message?: string; page?: string }> | unknown;
}
const FB_TYPE_LABEL: Record<string, string> = { suggestion: '意见与建议', error: '异常反馈', bug: '异常反馈', issue: '异常反馈', other: '其他' };
const FB_STATUS_LABEL: Record<string, string> = { pending: '待处理', handled: '已处理', done: '已处理', closed: '已处理', processing: '处理中', new: '待处理', resolved: '已处理', ignored: '已忽略' };
const fbType = (row: FeedbackRow) => FB_TYPE_LABEL[String(row.type || row.kind || '')] || (row.type || row.kind ? String(row.type || row.kind) : '意见与建议');
const fbStatus = (row: FeedbackRow) => FB_STATUS_LABEL[String(row.status || '')] || (row.status ? String(row.status) : '待处理');
const fbSource = (row: FeedbackRow) => /mini|wx|小程序/i.test(String(row.source || '')) ? '小程序' : /web|网页|admin/i.test(String(row.source || '')) ? '网页' : (row.source || '网页');
const fbAttachments = (row: FeedbackRow) => [
  ...(Array.isArray(row.attachments) ? row.attachments : []),
  ...(Array.isArray(row.attachmentUrls) ? row.attachmentUrls : []),
  ...(Array.isArray(row.imageUrls) ? row.imageUrls : []),
].flatMap((item: any) => {
  if (typeof item === 'string' && item) return [{ url: item, name: null }];
  if (item && typeof item === 'object' && item.url) return [{ url: String(item.url), name: item.name ? String(item.name) : null }];
  return [];
});
const fileName = (url: string) => { try { const path = decodeURIComponent(url.split('?')[0]); return path.split('/').pop() || '附件'; } catch { return '附件'; } };
const fbRecentErrors = (row: FeedbackRow): Array<{ at?: string; message?: string; page?: string }> => {
  const list = Array.isArray(row.recentErrors) ? row.recentErrors : Array.isArray(row.context?.recentErrors) ? row.context.recentErrors : [];
  return list.flatMap((item: any) => {
    if (typeof item === 'string') return [{ message: item }];
    if (item && typeof item === 'object' && item.message) return [{ at: item.at ? String(item.at) : undefined, message: String(item.message), page: item.page ? String(item.page) : undefined }];
    return [];
  });
};

function FeedbackPanel({ scopeKey }: { scopeKey: string }) {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const canEdit = can('logs', 'edit');

  useEffect(() => {
    let alive = true;
    setRows(null); setError(false);
    request<unknown>({ url: '/feedback', query: { page, pageSize: 20, kind: type || undefined, status: status || undefined, from: from || undefined, to: to || undefined } })
      .then((raw: any) => {
        if (!alive) return;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.list) ? raw.list : [];
        setRows(list);
        setTotal(Number(Array.isArray(raw) ? raw.length : raw?.total) || list.length);
      })
      .catch(() => { if (alive) { setRows([]); setError(true); } });
    return () => { alive = false; };
  }, [page, type, status, from, to, scopeKey, retry]);

  // 待处理数量徽标：单独查一次，不依赖当前筛选
  useEffect(() => {
    let alive = true;
    request<unknown>({ url: '/feedback', query: { page: 1, pageSize: 1, status: 'pending' } })
      .then((raw: any) => {
        if (!alive) return;
        const count = Number(Array.isArray(raw) ? raw.length : raw?.total ?? raw?.pendingCount ?? raw?.counts?.pending);
        if (Number.isFinite(count) && count >= 0) setPendingCount(count);
      })
      .catch(() => { if (alive) setPendingCount(null); });
    return () => { alive = false; };
  }, [scopeKey, retry]);

  const pages = Math.max(1, Math.ceil(total / 20));
  const pendingIds = (rows || []).filter((row) => fbStatus(row) === '待处理').map((row) => String(row.id));
  const allPendingSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) pendingIds.forEach((id) => next.delete(id));
      else pendingIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const setRowStatus = (id: string, nextStatus: string) => {
    setRows((prev) => prev ? prev.flatMap((row) => {
      if (String(row.id) !== id) return [row];
      if (status && nextStatus !== status) return [];
      return [{ ...row, status: nextStatus, handledByName: undefined, handledAt: undefined }];
    }) : prev);
    setPendingCount((count) => count == null ? count : Math.max(0, count + (nextStatus === 'handled' ? -1 : 1)));
  };
  const markHandled = async (row: FeedbackRow, nextStatus: 'handled' | 'pending') => {
    if (!canEdit || marking) return;
    const key = String(row.id);
    setMarking(key);
    try {
      await request({ method: 'PATCH', url: '/feedback/' + encodeURIComponent(key), data: { status: nextStatus } });
      setRowStatus(key, nextStatus);
      toast(nextStatus === 'handled' ? '已标记为已处理' : '已撤回为待处理');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '操作失败，请稍后重试');
    } finally {
      setMarking(null);
    }
  };
  const batchHandled = async () => {
    if (!canEdit || !selected.size || batchBusy) return;
    const ids = [...selected];
    setBatchBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await request({ method: 'PATCH', url: '/feedback/' + encodeURIComponent(id), data: { status: 'handled' } });
        setRowStatus(id, 'handled');
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    if (failed) toast(failed + ' 条失败');
    setRetry((value) => value + 1);
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="intro-list-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <b>用户反馈</b>
        <div className="chips" role="tablist" aria-label="反馈类型">
          {([['', '全部类型'], ['suggestion', '意见与建议'], ['error', '异常反馈']] as const).map(([key, label]) => (
            <button key={key} className={'chip ' + (type === key ? 'on' : '')} onClick={() => { setType(key); setPage(1); }}>{label}</button>
          ))}
        </div>
        <div className="chips" role="tablist" aria-label="反馈状态">
          {([['', '全部状态'], ['pending', '待处理'], ['handled', '已处理']] as const).map(([key, label]) => (
            <button key={key} className={'chip ' + (status === key ? 'on' : '')} onClick={() => { setStatus(key); setPage(1); }}>
              {key === 'pending' && pendingCount != null ? '待处理 ' + pendingCount : label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <input className="in" type="date" style={{ width: 145 }} value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1); }} aria-label="反馈开始日期" />
          <span className="muted">至</span>
          <input className="in" type="date" style={{ width: 145 }} value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1); }} aria-label="反馈结束日期" />
        </div>
      </div>

      {canEdit && selected.size > 0 ? (
        <div className="fb-batch">
          <span>已选 {selected.size} 条</span>
          <button className="btn sm p" disabled={batchBusy} onClick={() => void batchHandled()}>{batchBusy ? '处理中…' : '批量标记已处理'}</button>
          <button className="btn sm" disabled={batchBusy} onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      ) : null}

      {error ? (
        <div className="usage-missing" role="status">
          <span className="usage-tag">待接口</span>
          <b>用户反馈接口未就绪</b>
          <small>GET /feedback 暂不可用；接口上线后会显示类型、反馈人、时间、内容、附件、来源与状态。</small>
          <button className="btn sm" onClick={() => setRetry((value) => value + 1)}>重试</button>
        </div>
      ) : rows === null ? <div style={{ padding: 32 }}><Loading /></div> : (
        <>
          <div className="intro-table-wrap">
            <table className="t usage-table" style={{ minWidth: 980 }}>
              <thead><tr>
                <th className="fb-check-col">{canEdit ? <input type="checkbox" aria-label="全选待处理反馈" checked={allPendingSelected} onChange={togglePage} /> : null}</th>
                <th>类型</th><th>反馈人</th><th>时间</th><th>内容</th><th>附件</th><th>来源</th><th>状态</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => {
                  const key = String(row.id);
                  const open = expanded === key;
                  const files = fbAttachments(row);
                  const errors = fbRecentErrors(row);
                  const handled = fbStatus(row) === '已处理';
                  const trace = handled ? [row.handledByName || row.resolvedByName || row.processorName, row.handledAt ? dayjs(row.handledAt).format('YYYY-MM-DD HH:mm') : row.resolvedAt ? dayjs(row.resolvedAt).format('YYYY-MM-DD HH:mm') : null].filter(Boolean).join(' · ') : '';
                  return (
                    <Fragment key={key}>
                      <tr className="fb-row" onClick={() => setExpanded(open ? null : key)}>
                        <td className="fb-check-col" onClick={(event) => event.stopPropagation()}>
                          {canEdit && !handled ? <input type="checkbox" aria-label={'选择反馈 ' + key} checked={selected.has(key)} onChange={() => toggleSelect(key)} /> : null}
                        </td>
                        <td className="nw"><span className={'tag ' + (/异常|bug|error|issue/.test(String(row.type || row.kind)) ? 'warn' : 'acc')}>{fbType(row)}</span>{row.origin === 'legacy' ? <small className="fb-origin">历史</small> : row.origin === 'unified' ? <small className="fb-origin">统一</small> : null}</td>
                        <td className="nw">{row.userName || '未记录'}{row.userPhone ? <small className="muted"> · {row.userPhone}</small> : null}</td>
                        <td className="nw">{row.createdAt || row.time ? dayjs(row.createdAt || row.time).format('YYYY-MM-DD HH:mm') : '—'}</td>
                        <td><span className="fb-summary">{String(row.content || '—')}</span></td>
                        <td className="nw" onClick={(event) => event.stopPropagation()}>
                          {files.length ? files.map((file) => (
                            <span className="fb-file" key={file.url}>
                              <a href={file.url} target="_blank" rel="noopener">{file.name || fileName(file.url)}</a>
                              <a href={file.url} download={file.name || fileName(file.url)} title="下载">下载</a>
                            </span>
                          )) : '—'}
                        </td>
                        <td className="nw">{fbSource(row)}</td>
                        <td className="nw"><span className={'tag ' + (handled ? 'ok' : 'warn')}>{fbStatus(row)}</span>{trace ? <small className="fb-trace"> · {trace}</small> : null}</td>
                      </tr>
                      {open ? (
                        <tr className="fb-detail-row">
                          <td colSpan={8}>
                            <div className="fb-detail">
                              <b>完整内容</b>
                              <p>{String(row.content || '—')}</p>
                              {errors.length ? (
                                <div className="fb-detail-errors">
                                  <b>最近的系统报错（{errors.length} 条）</b>
                                  <ul className="fb-errors">{errors.map((item, index) => <li key={index}><time>{item.at ? dayjs(item.at).format('YYYY-MM-DD HH:mm:ss') : '时间未知'}</time><span>{item.message}</span>{item.page ? <small>{item.page}</small> : null}</li>)}</ul>
                                </div>
                              ) : null}
                              {files.length ? (
                                <div className="fb-detail-files">
                                  <b>附件</b>
                                  <div>{files.map((file) => <span className="fb-file" key={file.url}><a href={file.url} target="_blank" rel="noopener">{file.name || fileName(file.url)}</a><a href={file.url} download={file.name || fileName(file.url)}>下载</a></span>)}</div>
                                </div>
                              ) : null}
                              <div className="fb-detail-actions" onClick={(event) => event.stopPropagation()}>
                                {canEdit ? <button className="btn sm p" disabled={marking === key || batchBusy} onClick={() => void markHandled(row, handled ? 'pending' : 'handled')}>{marking === key ? '处理中…' : handled ? '撤回为待处理' : '标记已处理'}</button> : null}
                                {!handled && row.context?.page ? <a className="btn sm" href={String(row.context.page).startsWith('/') ? String(row.context.page) : '/' + String(row.context.page)}>去处理</a> : null}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? <div className="muted" style={{ padding: 40, textAlign: 'center' }}>暂无用户反馈</div> : null}
          </div>
          {total > 20 ? (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', padding: 14, borderTop: '1px solid var(--line2)' }}>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
              <span className="muted">第 {page} / {pages} 页 · 共 {total} 条</span>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ───────────── 使用统计下钻 ───────────── */
type DrillKind = 'page-events' | 'page-users' | 'user-events' | 'user-pages';
type DrillTarget = { kind: DrillKind; title: string; subtitle: string; path?: string; userId?: string };
const DRILL_COLUMNS: Record<DrillKind, string[]> = {
  'page-events': ['时间', '用户', 'IP'],
  'page-users': ['用户', '次数', '最近访问时间'],
  'user-events': ['时间', '页面'],
  'user-pages': ['页面', '次数', '最近时间'],
};
const drillGroup = (kind: DrillKind) => kind === 'page-users' ? 'users' : kind === 'user-pages' ? 'pages' : 'events';
const drillRow = (kind: DrillKind, row: any) => {
  const time = textValue(row?.time, row?.createdAt, row?.at, row?.visitedAt);
  const page = textValue(row?.page, row?.path, row?.pageName, row?.name) || '—';
  const user = textValue(row?.userName, row?.name, row?.user, row?.account) || '—';
  const ip = textValue(row?.ip, row?.ipAddress, row?.clientIp) || '—';
  const count = numberValue(row?.count ?? row?.views ?? row?.visits);
  const last = textValue(row?.lastAt, row?.lastVisitedAt, row?.lastSeenAt, row?.lastTime);
  return kind === 'page-events' ? [time, user, ip]
    : kind === 'page-users' ? [user, String(count), last]
      : kind === 'user-events' ? [time, page]
        : [page, String(count), last];
};

function UsageDrilldown({ target, from, to, onClose }: { target: DrillTarget; from: string; to: string; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setRows(null); setMissing(false);
    request<unknown>({ url: '/telemetry/page-usage/drilldown', query: { from, to, path: target.path, userId: target.userId, groupBy: drillGroup(target.kind), page, pageSize: 20 } })
      .then((raw: any) => {
        if (!alive) return;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.list) ? raw.list : [];
        setRows(list);
        setTotal(numberValue(Array.isArray(raw) ? raw.length : raw?.total) || list.length);
      })
      .catch(() => { if (alive) { setRows([]); setMissing(true); } });
    return () => { alive = false; };
  }, [target, from, to, page, retry]);
  const pages = Math.max(1, Math.ceil(total / 20));
  const columns = DRILL_COLUMNS[target.kind];
  return (
    <Sheet open onClose={onClose} width={720} title={target.title} subtitle={target.subtitle}>
      {missing ? (
        <div className="usage-missing" role="status">
          <span className="usage-tag">待接口</span>
          <b>下钻明细接口未就绪</b>
          <small>GET /telemetry/page-usage/drilldown 暂不可用；接口上线后这里会显示明细与分页。</small>
          <button className="btn sm" onClick={() => setRetry((value) => value + 1)}>重试</button>
        </div>
      ) : rows === null ? <Loading /> : (
        <>
          <div className="usage-drill-summary muted">时间窗 {from} 至 {to}{target.path ? ' · ' + target.path : ''}</div>
          <div className="intro-table-wrap">
            <table className="t usage-table">
              <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>{drillRow(target.kind, row).map((value, columnIndex) => <td key={columnIndex}>{value}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 ? <div className="muted" style={{ padding: 40, textAlign: 'center' }}>该范围内没有访问记录</div> : null}
          </div>
          {total > 20 ? (
            <div className="usage-drill-pager">
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
              <span className="muted">第 {page} / {pages} 页 · 共 {total} 条</span>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
