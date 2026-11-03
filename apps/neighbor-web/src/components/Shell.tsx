import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { auth, useSession } from '@/lib/auth';
import { notifications } from '@pms/api-client';
import Icon from '@/components/Icon';
import PageBoundary from '@/components/PageBoundary';
import type { IconName } from '@/components/Icon';
import { legacyUrl } from '@/lib/legacy';
import { statusOf } from '@/lib/format';

/**
 * 导航 = 图标竖栏（图标优先）。收费工作台相关的在最上面，
 * 其余域用分隔线隔开。带 legacy 的条目还没在新界面重做，点了跳回旧后台同名页。
 */
export interface NavItem {
  key: string;
  name: string;
  /** 竖栏里的短标签（≤4 字最佳），不填用 name */
  rail?: string;
  icon: IconName;
  to?: string;
  legacy?: string;
  /** 直接跳生产原版（蓝色旧后台，路径从根开始），不走 /beta-legacy 的改版皮肤 */
  prod?: string;
  group: string;
}

export const NAV: NavItem[] = [
  { key: 'today', name: '今日工作', rail: '今日', icon: 'today', to: '/today', group: '总览' },
  { key: 'cashier', name: '收银台', rail: '收银台', icon: 'cash', to: '/cashier', group: '收费' },
  { key: 'vehicles', name: '车辆管理', rail: '车辆', icon: 'car', to: '/vehicles', group: '收费' },
  { key: 'access-cards', name: '门禁管理', rail: '门禁', icon: 'key', to: '/access-cards', group: '收费' },
  { key: 'plates', name: '车牌登记审核', rail: '车牌', icon: 'key', to: '/plates', group: '收费' },
  { key: 'records', name: '办理记录', rail: '办理记录', icon: 'receipt', to: '/records', group: '收费' },
  { key: 'pending', name: '待处理', rail: '待处理', icon: 'alert', to: '/pending', group: '收费' },
  { key: 'bills', name: '账单与待缴', rail: '账单', icon: 'scale', to: '/bills', group: '收费' },
  { key: 'work-orders', name: '工单调度', rail: '工单', icon: 'kanban', to: '/work-orders', group: '报修' },
  { key: 'maint', name: '养护单', rail: '养护单', icon: 'file', to: '/maint', group: '报修' },
  { key: 'notes', name: '维修经验', rail: '经验', icon: 'book', to: '/experience', group: '报修' },
  { key: 'purchase', name: '采购流程', rail: '采购', icon: 'flow', to: '/purchase', group: '库存与盘点' },
  { key: 'stock', name: '库存', rail: '库存', icon: 'box', to: '/stock', group: '库存与盘点' },
  { key: 'count', name: '盘点', rail: '盘点', icon: 'clipboard', to: '/stocktakes', group: '库存与盘点' },
  { key: 'sku', name: '材料SKU', rail: 'SKU', icon: 'layers', to: '/materials', group: '库存与盘点' },
  { key: 'devices', name: '系统与设备', rail: '系统设备', icon: 'cpu', to: '/devices', group: '系统' },
  { key: 'reports', name: '收费报表', rail: '报表', icon: 'chart', to: '/reports', group: '分析' },
  { key: 'standards', name: '收费标准', rail: '收费标准', icon: 'wallet', to: '/standards', group: '收费' },
  { key: 'apartment', name: '公寓收费台', rail: '公寓', icon: 'building', to: '/apartment', group: '收费' },
  { key: 'houses', name: '房产', rail: '房产', icon: 'home', to: '/houses', group: '档案' },
  { key: 'owners', name: '业主', rail: '业主', icon: 'users', to: '/owners', group: '档案' },
  { key: 'people', name: '员工与权限', rail: '员工', icon: 'shield', to: '/staff', group: '档案' },
  { key: 'offices', name: '管理处', rail: '管理处', icon: 'building', to: '/offices', group: '档案' },
  { key: 'settings', name: '系统设置', rail: '设置', icon: 'gear', to: '/settings', group: '系统' },
  { key: 'qr', name: '楼栋报修码', rail: '报修码', icon: 'qr', to: '/qr', group: '系统' },
  { key: 'intranet', name: '内网应用', rail: '内网', icon: 'globe', to: '/intranet', group: '系统' },
  { key: 'logs', name: '日志', rail: '日志', icon: 'log', to: '/logs', group: '系统' },
];

/** 分类分组：每组一个标题 + 图标文字一行的菜单项 */
const GROUPS: Array<{ title: string; keys: string[]; icon: IconName; tone: string }> = [
  { title: '总览', keys: ['today'], icon: 'today', tone: 'green' },
  { title: '收费办理', keys: ['cashier', 'plates', 'vehicles', 'access-cards', 'apartment', 'bills', 'records', 'pending', 'standards'], icon: 'wallet', tone: 'blue' },
  { title: '报修养护', keys: ['work-orders', 'maint', 'notes'], icon: 'wrench', tone: 'orange' },
  { title: '库存与盘点', keys: ['purchase', 'stock', 'count', 'sku'], icon: 'box', tone: 'green' },
  { title: '分析', keys: ['reports'], icon: 'chart', tone: 'violet' },
  { title: '档案', keys: ['houses', 'owners', 'people', 'offices'], icon: 'home', tone: 'brown' },
  { title: '系统', keys: ['devices', 'settings', 'qr', 'intranet', 'logs'], icon: 'cpu', tone: 'slate' },
];

const PAGE_OF = (pathname: string) => pathname.split('/').filter(Boolean)[0] || 'today';

export default function Shell() {
  const session = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const [cmdk, setCmdk] = useState(false);
  const [q, setQ] = useState('');
  const [unread, setUnread] = useState(0);
  const page = PAGE_OF(loc.pathname);
  const current = NAV.find((i) => i.key === page) ?? NAV[0];

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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk((v) => !v); }
      if (e.key === 'Escape') setCmdk(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goto = (item: NavItem) => {
    setCmdk(false);
    if (item.prod) { window.location.href = item.prod; return; }
    if (item.legacy) { window.location.href = legacyUrl(item.legacy); return; }
    if (item.to) nav(item.to);
  };

  const offices = session.access?.offices ?? [];
  const office = session.actingOffice;
  const name = session.user?.name || session.user?.loginAccount || '未登录';
  const roleLabel = session.user?.roleNames?.[0] || (session.access?.isTenantAdmin ? '管理员' : '员工');
  const officeName = office?.name || (offices.length > 1 ? '全部管理处' : offices[0]?.name || '');

  const filtered = useMemo(() => {
    const kw = q.trim();
    const list = kw ? NAV.filter((i) => i.name.includes(kw) || i.key.includes(kw)) : NAV;
    return list.slice(0, 12);
  }, [q]);

  const badgeOf = (key: string) =>
    key === 'work-orders' ? counts.dispatch
      : key === 'today' ? counts.dispatch + counts.accept
        : 0;

  return (
    <div id="web">
      <aside className="side">
        <div className="side-brand" title="邻修 物业管理平台">
          <div className="logo">邻</div>
          <div className="txt"><b>邻修</b><small>物业管理</small></div>
        </div>

        <label className="scope-ib" title="切换管理处视角">
          <Icon name="building" size={18} />
          <small>{officeName || '全部管理处'}</small>
          <Icon name="chev" size={16} />
          <select
            value={office?.id ?? 0}
            onChange={(e) => {
              const id = Number(e.target.value);
              const target = offices.find((o) => o.id === id);
              auth.setActingOffice(id ? { id, name: target?.name || '' } : null);
              window.location.reload();
            }}
          >
            <option value={0}>全部管理处</option>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>

        <nav className="nav">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="navGroupTitle"><span className={"ic-tile navGroupTile t-" + g.tone}><Icon name={g.icon} size={12} /></span>{g.title}</div>
              {g.keys.map((k) => {
                const item = NAV.find((n) => n.key === k);
                if (!item) return null;
                const on = item.key === page;
                const badge = badgeOf(item.key);
                return (
                  <a
                    key={item.key}
                    className={on ? 'on' : ''}
                    onClick={() => goto(item)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') goto(item); }}
                    title={item.name}
                  >
                    <Icon name={item.icon} />
                    <span>{item.name}</span>
                    {badge ? <span className="n">{badge}</span> : item.legacy ? <span className="leg">旧</span> : null}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="me">
          <div className="av" title={`${name} · ${roleLabel}`}>{name.slice(0, 1)}</div>
          <div className="meName"><b>{name}</b><small>{roleLabel}</small></div>
          <button className="logout" title="退出登录" onClick={() => { auth.clear(); nav('/login'); }}>退出</button>
        </div>
      </aside>

      <section className="main">
        <header className="top">
          <div className="crumb">{current.group}<b>{current.name}</b></div>
          <div className="search" onClick={() => setCmdk(true)}>
            <Icon name="search" size={18} />
            <span>搜功能、房号、工单号…</span>
            <kbd>Ctrl K</kbd>
          </div>
          <button className="btn p" onClick={() => nav('/cashier')}>
            <Icon name="cash" size={18} />收费办理
          </button>
          <button className="ib" title="通知" onClick={() => { window.location.href = '/dashboard'; }}>
            <Icon name="bell" />
            {unread ? <span className="dot" /> : null}
          </button>
        </header>
        <div className="content">
          <div className="wrap">
            <PageBoundary resetKey={loc.pathname + loc.search}><Outlet /></PageBoundary>
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
      {['created', 'pending_accept', 'in_progress', 'waiting_material', 'done_pending_review', 'completed'].map((s) => (
        <span key={s} className={`pill ${statusOf(s).cls}`}>{statusOf(s).name}</span>
      ))}
    </div>
  );
}
