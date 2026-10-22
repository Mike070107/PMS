import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { auth, useSession } from '@/lib/auth';
import { notifications } from '@pms/api-client';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { toast } from '@/components/ui';
import { statusOf } from '@/lib/format';

/**
 * 导航结构 = 设计稿的信息架构（按「谁在什么场景做什么」分组）。
 * 底下带 legacy 的条目还没在新界面里重做，直接跳回现有后台的同名页面，
 * 功能不中断、界面暂时是旧的。
 */
export interface NavItem {
  key: string;
  name: string;
  /** 图标：一个词永久一枚，不做同义多图 */
  icon: IconName;
  /** 新版路由（相对 basename） */
  to?: string;
  /** 旧后台绝对路径；本次未迁移的页面 */
  legacy?: string;
}
export interface NavGroup { title: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { title: '', items: [{ key: 'today', name: '今日待办', icon: 'today', to: '/today' }] },
  {
    title: '报修服务',
    items: [
      { key: 'work-orders', name: '工单调度', icon: 'kanban', to: '/work-orders' },
      { key: 'maint', name: '养护单', icon: 'file', legacy: '/maintenance-orders' },
      { key: 'notes', name: '维修经验', icon: 'book', legacy: '/experience-notes' },
    ],
  },
  {
    title: '收费',
    items: [
      { key: 'cashier', name: '收银台', icon: 'cash', to: '/cashier' },
      { key: 'bills', name: '账单与欠费', icon: 'receipt', to: '/bills' },
      { key: 'recon', name: '收费对账', icon: 'scale', legacy: '/fees?tab=recon' },
    ],
  },
  {
    title: '车辆与门禁',
    items: [
      { key: 'vehicles', name: '住户车辆与门禁', icon: 'car', to: '/vehicles' },
      { key: 'devices', name: '设备中心', icon: 'cpu', to: '/devices' },
    ],
  },
  {
    title: '物资',
    items: [
      { key: 'purchase', name: '采购流程', icon: 'flow', to: '/purchase' },
      { key: 'stock', name: '库存', icon: 'box', to: '/stock' },
      { key: 'count', name: '盘点', icon: 'clipboard', legacy: '/stocktakes' },
      { key: 'sku', name: '材料库', icon: 'layers', legacy: '/materials' },
    ],
  },
  {
    title: '档案',
    items: [
      { key: 'houses', name: '房产', icon: 'home', legacy: '/properties' },
      { key: 'owners', name: '业主', icon: 'users', legacy: '/owners' },
      { key: 'people', name: '员工与权限', icon: 'shield', legacy: '/staff' },
      { key: 'offices', name: '管理处', icon: 'building', legacy: '/offices' },
    ],
  },
  { title: '分析', items: [{ key: 'reports', name: '报表', icon: 'chart', legacy: '/reports' }] },
  {
    title: '系统',
    items: [
      { key: 'settings', name: '系统设置', icon: 'gear', to: '/settings' },
      { key: 'qr', name: '楼栋报修码', icon: 'qr', legacy: '/qr' },
      { key: 'intranet', name: '内网应用', icon: 'globe', legacy: '/external-access' },
      { key: 'logs', name: '日志', icon: 'log', legacy: '/logs' },
    ],
  },
];

/**
 * 未迁移页面所在位置。生产和旧后台同域根路径，测试环境旧后台部署在 /beta-legacy/，
 * 用 VITE_LEGACY_BASE 切，避免把测试环境的点击带回生产界面。
 */
const LEGACY_BASE = (import.meta.env.VITE_LEGACY_BASE || '').replace(/\/$/, '');

const ALL_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title || '总览' })));
const PAGE_OF = (pathname: string) => {
  const seg = pathname.split('/').filter(Boolean)[0] || 'today';
  return seg;
};

export default function Shell() {
  const session = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const [cmdk, setCmdk] = useState(false);
  const [q, setQ] = useState('');
  const [unread, setUnread] = useState(0);
  const page = PAGE_OF(loc.pathname);
  const current = ALL_ITEMS.find((i) => i.key === page) ?? ALL_ITEMS[0];

  // 侧栏角标：待派单 + 待验收（进页面前就知道有多少事）
  const [counts, setCounts] = useState<{ dispatch: number; accept: number }>({ dispatch: 0, accept: 0 });

  useEffect(() => {
    let alive = true;
    notifications.unreadCount().then((r) => { if (alive) setUnread(r.count); }).catch(() => undefined);
    import('@pms/api-client').then(({ repairs }) => repairs.badgeCounts())
      .then((b) => { if (alive) setCounts({ dispatch: b.dispatch, accept: b.pool }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdk((v) => !v);
      }
      if (e.key === 'Escape') setCmdk(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goto = (item: NavItem) => {
    setCmdk(false);
    if (item.legacy) {
      // 旧后台在站点根路径下，这里必须整页跳转（两套前端独立的构建产物）
      window.location.href = `${LEGACY_BASE}${item.legacy}`;
      return;
    }
    if (item.to) nav(item.to);
  };

  const offices = session.access?.offices ?? [];
  const office = session.actingOffice;
  const name = session.user?.name || session.user?.loginAccount || '未登录';
  const roleLabel = session.user?.roleNames?.[0] || (session.access?.isTenantAdmin ? '管理员' : '员工');
  const officeName = office?.name || (offices.length > 1 ? '全部管理处' : offices[0]?.name || '');

  const filtered = useMemo(() => {
    const kw = q.trim();
    const list = kw ? ALL_ITEMS.filter((i) => i.name.includes(kw) || i.key.includes(kw)) : ALL_ITEMS;
    return list.slice(0, 12);
  }, [q]);

  return (
    <div id="web">
      <aside className="side">
        <div className="brand">
          <div className="logo">邻</div>
          <div>
            <b>邻修</b>
            <small>物业管理平台</small>
          </div>
        </div>
        <div className="scope" title="切换管理处视角">
          <select
            value={office?.id ?? 0}
            onChange={(e) => {
              const id = Number(e.target.value);
              const target = offices.find((o) => o.id === id);
              auth.setActingOffice(id ? { id, name: target?.name || '' } : null);
              window.location.reload();
            }}
            style={{ border: 0, background: 'transparent', width: '100%', outline: 'none', cursor: 'pointer' }}
          >
            <option value={0}>全部管理处</option>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.title || 'top'}>
              {g.title ? <h6>{g.title}</h6> : null}
              {g.items.map((item) => {
                const on = item.key === page;
                const badge = item.key === 'work-orders' ? counts.dispatch : item.key === 'today' ? counts.dispatch + counts.accept : 0;
                return (
                  <a
                    key={item.key}
                    className={on ? 'on' : ''}
                    onClick={() => goto(item)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') goto(item); }}
                  >
                    <Icon name={item.icon} />
                    <span>{item.name}</span>
                    {badge ? <span className="n">{badge}</span> : null}
                    {item.legacy ? <span className="leg">旧</span> : null}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="me">
          <div className="av">{name.slice(0, 1)}</div>
          <div style={{ minWidth: 0 }}>
            <b>{name}</b>
            <div className="muted" style={{ fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {roleLabel}{officeName ? ` · ${officeName}` : ''}
            </div>
          </div>
          <button
            className="btn g sm"
            style={{ marginLeft: 'auto' }}
            title="退出登录"
            onClick={() => { auth.clear(); nav('/login'); }}
          >
            退出
          </button>
        </div>
      </aside>

      <section className="main">
        <header className="top">
          <div className="crumb">{current.group}<b>{current.name}</b></div>
          <div className="search" onClick={() => setCmdk(true)}>
            <Icon name="search" size={18} />
            <span>搜房号、单号、车牌、功能…</span>
            <kbd>Ctrl K</kbd>
          </div>
          <button className="btn p" onClick={() => nav('/work-orders?new=1')}>
            <Icon name="plus" size={18} />新建
          </button>
          <button className="ib" title="通知" onClick={() => { window.location.href = '/dashboard'; }}>
            <Icon name="bell" />
            {unread ? <span className="dot" /> : null}
          </button>
        </header>
        <div className="content">
          <div className="wrap">
            <Outlet />
          </div>
        </div>
      </section>

      {cmdk ? (
        <div className="cmdk" onClick={() => setCmdk(false)}>
          <div className="box" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={q}
              placeholder="输入功能名称，或工单号（WO-…）"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const kw = q.trim();
                  if (/^WO-/i.test(kw)) { setCmdk(false); nav(`/work-orders?q=${encodeURIComponent(kw)}`); return; }
                  if (filtered[0]) goto(filtered[0]);
                }
              }}
            />
            <div className="list">
              <h6>页面</h6>
              {filtered.map((i) => (
                <div key={i.key} className="it" onClick={() => goto(i)}>
                  <span>{i.name}</span>
                  <small>{i.group}{i.legacy ? ' · 旧版' : ''}</small>
                </div>
              ))}
              {filtered.length === 0 ? <div className="empty" style={{ padding: 20 }}>没有匹配的功能</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StatusLegend() {
  return (
    <div className="chips">
      {['created', 'dispatched', 'in_progress', 'waiting_material', 'done_pending_review', 'completed'].map((s) => (
        <span key={s} className={`pill ${statusOf(s).cls}`}>{statusOf(s).name}</span>
      ))}
    </div>
  );
}
