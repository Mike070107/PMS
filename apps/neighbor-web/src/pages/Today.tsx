import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { ago, dayjs, dueText, isActive, isOverdue, money, statusOf } from '@/lib/format';
import { Card, ErrorNote, Loading, Pill } from '@/components/ui';

interface Txn { id: number; amountCents: number; createdAt: string }

export default function Today() {
  const nav = useNavigate();
  const session = useSession();
  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    repairs.list({ scope: 'all' })
      .then((r) => { if (alive) setOrders(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : '工单加载失败'); });
    request<Txn[]>({ url: '/business/transactions' })
      .then((r) => { if (alive) setTxns(r); })
      .catch(() => { if (alive) setTxns([]); });
    return () => { alive = false; };
  }, []);

  const stat = useMemo(() => {
    const list = orders ?? [];
    const today = dayjs().startOf('day');
    const created = list.filter((o) => o.createdAt && dayjs(o.createdAt).isAfter(today)).length;
    const done = list.filter((o) => o.completedAt && dayjs(o.completedAt).isAfter(today)).length;
    const active = list.filter((o) => isActive(o.status));
    const overdue = active.filter((o) => isOverdue(o));
    const by = (s: WorkOrderStatus) => list.filter((o) => o.status === s).length;
    const payToday = (txns ?? []).filter((t) => dayjs(t.createdAt).isAfter(today));
    return {
      created,
      done,
      overdue: overdue.length,
      pending: by(WorkOrderStatus.CREATED),
      waitAccept: by(WorkOrderStatus.DISPATCHED),
      working: by(WorkOrderStatus.IN_PROGRESS),
      material: by(WorkOrderStatus.WAITING_MATERIAL),
      review: by(WorkOrderStatus.DONE_PENDING_REVIEW),
      payAmount: payToday.reduce((s, t) => s + (t.amountCents || 0), 0),
      payCount: payToday.length,
      active,
    };
  }, [orders, txns]);

  const workers = useMemo(() => {
    const map = new Map<string, number>();
    (stat.active || []).forEach((o) => {
      const name = o.assigneeName || '未指派';
      map.set(name, (map.get(name) ?? 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [stat.active]);

  const urgent = useMemo(() => {
    return [...(orders ?? [])]
      .filter((o) => isActive(o.status) && (o.urgent || isOverdue(o)))
      .sort((a, b) => (a.slaDueAt || '').localeCompare(b.slaDueAt || ''))
      .slice(0, 6);
  }, [orders]);

  const name = session.user?.name || session.user?.loginAccount || '';
  const hour = dayjs().hour();
  const greet = hour < 6 ? '凌晨好' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  if (orders === null && !err) return <Loading />;

  const rows: Array<[string, string, number, string, boolean]> = [
    ['待派单', '点进去直接是待派单列，带推荐维修工', stat.pending, '/work-orders?filter=created', true],
    ['已超时', '超过要求完成时间仍未完工', stat.overdue, '/work-orders?filter=overdue', true],
    ['待业主验收', '可代业主验收或催业主确认', stat.review, '/work-orders?filter=done_pending_review', false],
    ['等材料的工单', '跟踪采购进度，到料后继续维修', stat.material, '/work-orders?filter=waiting_material', false],
  ];

  return (
    <>
      <div className="ph">
        <div>
          <h1>{greet}，{name || '管理员'}</h1>
          <p>{dayjs().format('M 月 D 日 dddd')} · 实时数据来自正式库</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => nav('/work-orders?view=board')}>看工单看板</button>
          <button className="btn p" onClick={() => nav('/work-orders?new=1')}>＋ 登记报修</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="kpis">
        <div><small>今日新增工单</small><b>{stat.created}</b><em>进行中 {stat.active.length} 单</em></div>
        <div><small>今日完工</small><b>{stat.done}</b><em>待验收 {stat.review} 单</em></div>
        <div><small>今日收款</small><b>{txns === null ? '…' : `¥ ${(stat.payAmount / 100).toFixed(2)}`}</b><em>{stat.payCount} 笔 · 前台收费</em></div>
        <div><small>已超时</small><b style={{ color: stat.overdue ? 'var(--dang)' : undefined }}>{stat.overdue}</b><em>紧急 {urgent.filter((o) => o.urgent).length} 单</em></div>
      </div>

      <div className="dash">
        <Card>
          <div style={{ padding: '14px 16px 6px' }} className="sec-t">
            需要处理<span className="r muted">点击直达已筛选好的列表</span>
          </div>
          <div className="todo">
            {rows.map(([t, d, n, to, hot]) => (
              <Link key={t} to={to}>
                <span className={`num ${hot && n ? 'hot' : ''}`}>{orders === null ? '…' : n}</span>
                <div><b>{t}</b><span className="d">{d}</span></div>
                <span className="go">处理 →</span>
              </Link>
            ))}
          </div>
        </Card>

        <div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ padding: '14px 16px 0' }} className="sec-t">常用操作</div>
            <div className="quick">
              <button onClick={() => nav('/work-orders?new=1')}><b>登记报修</b><span>电话 / 前台来访</span></button>
              <button onClick={() => nav('/cashier')}><b>收费</b><span>物业费、停车、门禁卡</span></button>
              <button onClick={() => nav('/vehicles')}><b>查房号 / 车牌</b><span>车辆授权、门禁卡</span></button>
              <button onClick={() => nav('/purchase')}><b>采购申请</b><span>缺料、零星采买</span></button>
            </div>
          </Card>

          <Card>
            <div style={{ padding: '14px 16px 4px' }} className="sec-t">维修工在手单数<span className="r muted">进行中的工单</span></div>
            {workers.length ? (
              <table className="t">
                <tbody>
                  {workers.map(([w, n]) => (
                    <tr key={w}>
                      <td style={{ width: 90 }}><b>{w}</b></td>
                      <td><div className="bar" style={{ width: 120 }}><i style={{ width: `${Math.min(100, n * 18)}%`, background: n >= 5 ? 'var(--dang)' : undefined }} /></div></td>
                      <td style={{ textAlign: 'right' }}>{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty" style={{ padding: 24 }}>当前没有进行中的工单</div>}
          </Card>
        </div>
      </div>

      <Card style={{ marginTop: 16 }}>
        <div style={{ padding: '14px 16px 6px' }} className="sec-t">
          紧急 / 已超时<span className="r muted">按要求完成时间排序</span>
        </div>
        {urgent.length ? (
          <table className="t">
            <thead>
              <tr><th>地址</th><th>问题</th><th>状态</th><th>负责人</th><th>要求完成</th></tr>
            </thead>
            <tbody>
              {urgent.map((o) => (
                <tr key={o.id} className="row" onClick={() => nav(`/work-orders?sel=${o.id}`)}>
                  <td><b>{o.summaryAddress || '—'}</b>{o.urgent ? <span className="pill urg" style={{ marginLeft: 6 }}>紧急</span> : null}</td>
                  <td className="sub" style={{ maxWidth: 320 }}>{o.summaryContent || '—'}</td>
                  <td><Pill status={o.status} /></td>
                  <td>{o.assigneeName || <span className="muted">未指派</span>}</td>
                  <td className={isOverdue(o) ? 'over' : ''}>{dueText(o.slaDueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty" style={{ padding: 30 }}>没有紧急或超时的工单</div>}
      </Card>

      <div className="note" style={{ marginTop: 16 }}>
        新版界面（测试环境）。统计口径：今日新增按建单时间、今日完工按完工时间，「今日收款」取自前台收费流水。
        养护单、报表、账单等页面尚未迁移，左侧标「旧」的入口会跳回原后台。
      </div>
    </>
  );
}
