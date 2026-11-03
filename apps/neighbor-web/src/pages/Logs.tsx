import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { request } from '@pms/api-client';
import { legacyUrl } from '@/lib/legacy';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';

interface Overview {
  periodHours: number;
  summary: { requests: number; errors: number; slowRequests: number; avgDurationMs: number; maxDurationMs: number; activeUsers: number };
  logCounts: Record<string, number>;
  runtime: { status: 'healthy' | 'unhealthy'; dbStatus: 'up' | 'down'; dbLatencyMs: number; uptimeSeconds: number; processRssMb: number; serverFreeMemoryMb: number; serverTotalMemoryMb: number };
}
interface LogRow {
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
 * 走 /observability/overview、/observability/logs。异常反馈的状态流转与明细导出仍在旧页。
 */
export default function Logs() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [cat, setCat] = useState('');
  const [onlyFail, setOnlyFail] = useState(false);
  const [kw, setKw] = useState('');
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<LogList | null>(null);

  useEffect(() => { request<Overview>({ url: '/observability/overview' }).then(setOv).catch(() => setOv(null)); }, []);
  useEffect(() => {
    setLogs(null);
    const t = setTimeout(() => {
      request<LogList>({ url: '/observability/logs', query: { page, pageSize: 30, category: cat || undefined, success: onlyFail ? false : undefined, keyword: kw.trim() || undefined } })
        .then(setLogs).catch(() => setLogs({ list: [], total: 0, page: 1, pageSize: 30 }));
    }, kw ? 350 : 0);
    return () => clearTimeout(t);
  }, [cat, onlyFail, kw, page]);

  const pages = logs ? Math.max(1, Math.ceil(logs.total / logs.pageSize)) : 1;
  const rt = ov?.runtime;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="logs" /><h1 style={{ fontSize: 22 }}>日志</h1></div><p>系统运行状况与操作记录</p></div>
        <div className="act"><button className="btn" onClick={() => { window.location.href = legacyUrl('/logs'); }}><Icon name="log" size={18} />反馈处理 / 导出</button></div>
      </div>

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
          <button key={c.k} className={`chip ${cat === c.k ? 'on' : ''}`} onClick={() => { setCat(c.k); setPage(1); }}>
            <Icon name={c.icon} size={14} />{c.n}{c.k && ov?.logCounts?.[c.k] ? ` ${ov.logCounts[c.k]}` : ''}
          </button>
        ))}</div>
        <button className={`chip ${onlyFail ? 'on' : ''}`} onClick={() => { setOnlyFail(!onlyFail); setPage(1); }}>只看失败</button>
        <input className="in" style={{ width: 240, marginLeft: 'auto' }} value={kw} placeholder="搜操作人 / 内容 / 路径" onChange={(e) => { setKw(e.target.value); setPage(1); }} />
      </div>

      {logs === null ? <Loading /> : logs.list.length === 0 ? <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="muted">没有匹配的记录</span></div> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="rowList">
            {logs.list.map((l) => {
              const meta = CATS.find((c) => c.k === l.category) || CATS[0];
              return (
                <div key={l.id} className="lrow">
                  <div className={`li ic ${l.success ? meta.tone : 'red'}`}><Icon name={l.success ? meta.icon : 'alert'} /></div>
                  <div className="lt">
                    <b style={{ fontWeight: 600 }}>{l.message || l.action}{l.success ? null : <span className="tag dang" style={{ marginLeft: 6 }}>失败</span>}</b>
                    <small>{l.actorName || '系统'} · {SRC[l.source] || l.source}{l.requestPath ? ` · ${l.requestMethod || ''} ${l.requestPath}` : ''}{l.statusCode ? ` · ${l.statusCode}` : ''}{l.durationMs != null ? ` · ${l.durationMs}ms` : ''}</small>
                  </div>
                  <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{dayjs(l.createdAt).format('MM-DD HH:mm:ss')}</span>
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
