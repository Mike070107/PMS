import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { dayjs, isActive, isOverdue, money, stageOf } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';

interface Txn {
  id: number; txnNo: string; serviceType: string; status: string;
  amountCents: number; paymentMethod: string | null; createdAt: string;
}

const SERVICE_LABEL: Record<string, string> = { parking_monthly: '停车月租', access_card: '门禁卡' };
const svcIcon = (s: string): IconName => (s === 'parking_monthly' ? 'car' : s === 'access_card' ? 'key' : 'cash');

/**
 * 今日工作：以收费为导向。顶部今日前台收款（停车+门禁的 business 流水），
 * 分项收入、需要处理（工单待办 + 外部失败入口）、最近收款。
 * 物业费收款在另一套账（fees），这里不混入一个口径，标注清楚。
 */
export default function Today() {
  const nav = useNavigate();
  const session = useSession();
  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);

  useEffect(() => {
    let alive = true;
    repairs.list({ scope: 'all' }).then((r) => { if (alive) setOrders(r); }).catch(() => { if (alive) setOrders([]); });
    request<Txn[]>({ url: '/business/transactions' }).then((r) => { if (alive) setTxns(r); }).catch(() => { if (alive) setTxns([]); });
    return () => { alive = false; };
  }, []);

  const today = dayjs().startOf('day');
  const todayTxns = useMemo(() => (txns ?? []).filter((t) => dayjs(t.createdAt).isAfter(today)), [txns]);
  const paid = useMemo(() => todayTxns.filter((t) => t.status !== 'refunded'), [todayTxns]);
  const refunded = useMemo(() => todayTxns.filter((t) => t.status === 'refunded'), [todayTxns]);
  const income = paid.reduce((s, t) => s + t.amountCents, 0);
  const refund = refunded.reduce((s, t) => s + t.amountCents, 0);
  const bySvc = (s: string) => paid.filter((t) => t.serviceType === s);
  const parkSum = bySvc('parking_monthly').reduce((s, t) => s + t.amountCents, 0);
  const cardSum = bySvc('access_card').reduce((s, t) => s + t.amountCents, 0);
  const maxSum = Math.max(parkSum, cardSum, 1);

  const repairStat = useMemo(() => {
    const list = orders ?? [];
    const active = list.filter((o) => isActive(o.status));
    const by = (s: WorkOrderStatus) => list.filter((o) => o.status === s).length;
    return {
      pending: list.filter((o) => stageOf(o) === WorkOrderStatus.CREATED).length,
      accepting: list.filter((o) => stageOf(o) === 'pending_accept').length,
      review: by(WorkOrderStatus.DONE_PENDING_REVIEW),
      material: by(WorkOrderStatus.WAITING_MATERIAL),
      overdue: active.filter((o) => isOverdue(o)).length,
      active: active.length,
    };
  }, [orders]);

  const name = session.user?.name || session.user?.loginAccount || '管理员';
  const officeName = session.actingOffice?.name || (session.access?.scopeAll ? '全部管理处' : '');

  if (orders === null && txns === null) return <Loading />;

  const todoRows: Array<{ icon: IconName; tone: string; t: string; d: string; n: number; to: string }> = [
    { icon: 'kanban', tone: 'red', t: '待派单工单', d: '没有自动派出去的，要办公室派', n: repairStat.pending, to: '/work-orders?filter=created' },
    { icon: 'kanban', tone: 'blue', t: '待维修工接单', d: '已自动通知默认维修工，久没人接就改派', n: repairStat.accepting, to: '/work-orders?filter=pending_accept' },
    { icon: 'clock', tone: 'amber', t: '已超时工单', d: '超过要求完成时间仍未完工', n: repairStat.overdue, to: '/work-orders?filter=overdue' },
    { icon: 'check', tone: 'blue', t: '待业主验收', d: '可代业主验收或催业主确认', n: repairStat.review, to: '/work-orders?filter=done_pending_review' },
    { icon: 'box', tone: 'amber', t: '等材料的工单', d: '到料后继续维修', n: repairStat.material, to: '/work-orders?filter=waiting_material' },
  ];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>今日工作</h1>
          <p>{dayjs().format('YYYY 年 M 月 D 日 dddd')}{officeName ? ` · ${officeName}` : ''} · 实时数据来自正式库</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => nav('/work-orders?new=1')}><Icon name="plus" size={18} />登记报修</button>
          <button className="btn p" onClick={() => nav('/cashier')}><Icon name="cash" size={18} />收费办理</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 20, alignItems: 'start' }}>
        <div>
          <div className="hero">
            <div className="lbl"><Icon name="wallet" size={17} />今日前台收款（停车 + 门禁 · {officeName || '本账号范围'}）</div>
            <div className="big money"><small>¥</small>{(income / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
            <div className="split">
              <div><div className="k">实收</div><div className="v money">{money(income / 100)}</div></div>
              <div><div className="k">退款</div><div className="v money">{refund ? `−${money(refund / 100)}` : '¥0.00'}</div></div>
              <div><div className="k">收款笔数</div><div className="v">{paid.length} 笔</div></div>
              <div><div className="k">进行中工单</div><div className="v">{repairStat.active} 单</div></div>
            </div>
          </div>

          <div className="statRow" style={{ marginTop: 20 }}>
            <div className="stat"><div className="ic blue"><Icon name="car" /></div><div className="v money">{money(parkSum / 100)}</div><div className="k">停车 · {bySvc('parking_monthly').length} 笔</div></div>
            <div className="stat"><div className="ic amber"><Icon name="key" /></div><div className="v money">{money(cardSum / 100)}</div><div className="k">门禁卡 · {bySvc('access_card').length} 笔</div></div>
            <div className="stat"><div className="ic green"><Icon name="home" /></div><div className="v" style={{ fontSize: 17, color: 'var(--ink3)' }}>另一账口径</div><div className="k">物业费在「账单与待缴」</div></div>
          </div>

          <div className="card" style={{ marginTop: 20, padding: '18px 20px' }}>
            <div className="side-h"><Icon name="chart" size={19} style={{ color: 'var(--acc-t)' }} />今日分项收入</div>
            <div style={{ marginTop: 12 }}>
              {[['停车月租', parkSum, 'var(--acc)'], ['门禁卡', cardSum, 'var(--warn)']].map(([nm, v, col]) => (
                <div key={nm as string} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                  <div style={{ width: 80, fontSize: 13.5, color: 'var(--ink2)' }}>{nm as string}</div>
                  <div style={{ flex: 1, height: 10, borderRadius: 6, background: 'var(--line2)', overflow: 'hidden' }}><div style={{ height: '100%', borderRadius: 6, width: `${Math.round((v as number) / maxSum * 100)}%`, background: col as string }} /></div>
                  <div style={{ width: 100, textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{money((v as number) / 100)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <button className="btn p lg" style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }} onClick={() => nav('/cashier')}>
            <Icon name="cash" />开始收费办理
          </button>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="side-h" style={{ padding: '16px 18px 2px' }}><Icon name="alert" size={19} style={{ color: 'var(--warn)' }} />需要处理</div>
            <div className="rowList">
              {todoRows.map((r) => (
                <button key={r.t} className="lrow click" onClick={() => nav(r.to)}>
                  <div className={`li ic ${r.n ? r.tone : 'blue'}`}><Icon name={r.icon} /></div>
                  <div className="lt"><b>{r.t}</b><small>{r.d}</small></div>
                  <b style={{ fontSize: 20, color: r.n && (r.tone === 'red' || r.tone === 'amber') ? 'var(--dang)' : 'var(--ink)' }}>{orders === null ? '…' : r.n}</b>
                </button>
              ))}
              <button className="lrow click" onClick={() => nav('/pending')}>
                <div className="li ic amber"><Icon name="cpu" /></div>
                <div className="lt"><b>外部任务待处理</b><small>停车/写卡/MIS 的失败与待核验</small></div>
                <Icon name="chev" className="go" />
              </button>
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
            <div className="side-h" style={{ padding: '16px 18px 2px' }}><Icon name="receipt" size={19} style={{ color: 'var(--acc-t)' }} />最近收款</div>
            <div className="rowList">
              {paid.length === 0 ? <div className="empty" style={{ padding: 28 }}>今天还没有停车/门禁收款</div>
                : paid.slice(0, 5).map((t) => (
                  <div key={t.id} className="lrow">
                    <div className="li ic green"><Icon name={svcIcon(t.serviceType)} /></div>
                    <div className="lt"><b>{SERVICE_LABEL[t.serviceType] || t.serviceType}</b><small>{t.txnNo} · {t.paymentMethod || '—'} · {dayjs(t.createdAt).format('HH:mm')}</small></div>
                    <b className="money">{money(t.amountCents / 100)}</b>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>

      <div className="note2" style={{ marginTop: 18 }}><Icon name="alert" />「今日前台收款」只含停车 + 门禁的 business 流水；物业费是另一套账，在「账单与待缴」里看。外部动作（停车续期/写卡/MIS 记账）当前仅登记，真实下发与核验在「待处理」跟踪。</div>
    </>
  );
}
