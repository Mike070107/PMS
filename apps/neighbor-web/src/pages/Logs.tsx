import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { request } from '@pms/api-client';
import { logObjectLabel, safeLogTechnical, type LogPresentation } from '@/lib/logs-presentation';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';
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

const CATS: Array<{ k: string; n: string; icon: IconName; tone: string }> = [
  { k: '', n: '全部', icon: 'log', tone: 'blue' },
  { k: 'operation', n: '业务操作', icon: 'check', tone: 'blue' },
  { k: 'login', n: '登录', icon: 'users', tone: 'green' },
  { k: 'error', n: '自动异常', icon: 'alert', tone: 'red' },
  { k: 'feedback', n: '异常反馈', icon: 'bell', tone: 'amber' },
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
        <div><div className="h1row"><ToneIcon kind="logs" /><h1 style={{ fontSize: 22 }}>日志</h1></div><p>系统运行状况与操作记录</p></div>
        <div className="act"><button className="btn" onClick={() => {setRetryLogs(v=>v+1);setRetryOverview(v=>v+1);}}>刷新</button></div>
      </div>

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
    </>
  );
}
