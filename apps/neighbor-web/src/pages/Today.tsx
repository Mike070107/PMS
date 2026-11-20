import './erp-today.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { dayjs, formatBeijingDateTime, isActive, isOverdue, money, stageOf } from '@/lib/format';
import Icon from '@/components/Icon';
import { TodayIncome } from './TodayIncome';
import type { IconName } from '@/components/Icon';

interface Txn {
  id: number; txnNo: string; serviceType: string; status: string;
  amountCents: number; paymentMethod: string | null; createdAt: string;
}
type LedgerSummary = { paidCents: number; refundedCents: number; paidCount: number; byService: Array<{ serviceType: string; paidCents: number; paidCount: number }> };
type MisToday = { paidCents: number; paidCount: number; refundedCents: number; paidHouses: number; dataAsOf?: string | null };
type RecentPayment = { paidAt: string; address: string; ownerName: string; amountCents: number; channel: string | null; billCount: number; recordedAt: string | null };
type MisState = { key: string; today: MisToday | null; todayMissing: boolean };
type RecentState = { key: string; page: number; rows: RecentPayment[]; total: number; houseCount: number | null; seenHouses: string[]; missing: boolean; loading: boolean; paged: boolean };

const CHANNEL_LABEL: Record<string, string> = { wechat: '微信', alipay: '支付宝', cash: '现金', bank: '银行', pos: '刷卡', transfer: '转账', other: '其他' };
const channelLabel = (raw: string | null) => (!raw ? '渠道未记录' : CHANNEL_LABEL[raw.toLowerCase()] || raw);

function normalizeMisToday(raw: unknown): MisToday | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const paidCents = Number(data.paidCents);
  if (!Number.isSafeInteger(paidCents) || paidCents < 0) return null;
  return {
    paidCents,
    paidCount: Number(data.paidCount) || 0,
    refundedCents: Number(data.refundedCents) || 0,
    paidHouses: Number(data.paidHouses) || 0,
    dataAsOf: typeof data.dataAsOf === 'string' ? data.dataAsOf : null,
  };
}
function normalizeRecent(raw: unknown): { rows: RecentPayment[]; total: number; houseCount: number | null; paged: boolean } | null {
  const mapRow = (row: any): RecentPayment => ({
    paidAt: String(row?.paidAt || row?.paidDate || ''),
    address: String(row?.address || ''),
    ownerName: String(row?.ownerName || ''),
    amountCents: Number(row?.amountCents) || 0,
    channel: row?.channel ? String(row.channel) : null,
    billCount: Number(row?.billCount) || 1,
    recordedAt: row?.recordedAt ? String(row.recordedAt) : null,
  });
  if (Array.isArray(raw)) return { rows: raw.map(mapRow), total: raw.length, houseCount: null, paged: false };
  const list = Array.isArray((raw as any)?.rows) ? (raw as any).rows : Array.isArray((raw as any)?.list) ? (raw as any).list : null;
  if (!list) return null;
  return {
    rows: list.map(mapRow),
    total: Number((raw as any)?.total) || list.length,
    houseCount: Number.isFinite(Number((raw as any)?.houseCount)) && Number((raw as any).houseCount) >= 0 ? Number((raw as any).houseCount) : null,
    paged: true,
  };
}

/**
 * 今日工作：顶部三卡用 MIS 当日口径（/fees/mis/today）；PMS 当日收款单独一行小字并列，两者不混算。
 * 最近收款用 /fees/mis/recent-payments（MIS 收款时间只有日期精度，只显示日期）。
 * 任一 MIS 接口未就绪时显示「待接口」空态，不用 0 冒充数据。
 */
export default function Today() {
  const nav = useNavigate();
  const session = useSession();
  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [ledger, setLedger] = useState<{ key: string; data: { rows: Txn[]; summary: LedgerSummary } } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [retryMis, setRetryMis] = useState(0);
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const scope = JSON.stringify([session.generation, session.user?.id, session.actingTenant?.id, session.access?.scopeAll, session.access?.communityIds]);
  const key = JSON.stringify([scope, date, retry]);
  const misKey = JSON.stringify([scope, date, retryMis]);
  const generation = useRef({ key, n: 0 });
  if (generation.current.key !== key) generation.current = { key, n: generation.current.n + 1 };
  const [ordersErr, setOrdersErr] = useState<{ scope: string; message: string } | null>(null);
  const [ordersRetry, setOrdersRetry] = useState(0);
  const ordersScope = useRef(scope);
  const visibleOrders = ordersScope.current === scope ? orders : null;
  const orderFailure = ordersErr?.scope === scope ? ordersErr.message : '';
  const [mis, setMis] = useState<MisState | null>(null);
  const [recentPage, setRecentPage] = useState(1);
  const [recent, setRecent] = useState<RecentState | null>(null);
  useEffect(() => {
    let alive = true;
    setOrders(null); setOrdersErr(null);
    repairs.list({ scope: 'all' }).then(r => { if (alive) { ordersScope.current = scope; setOrders(r); } }).catch(() => { if (alive) setOrdersErr({ scope, message: '工单读取失败，数量未获取，请重试' }); });
    return () => { alive = false; };
  }, [scope, ordersRetry]);

  useEffect(() => {
    const n = ++generation.current.n;
    let alive = true;
    const valid = () => alive && generation.current.key === key && generation.current.n === n;
    setFailure(null);
    request<{ rows: Txn[]; summary: LedgerSummary }>({ url: '/business/transaction-ledger', query: { from: date, to: date, page: 1, pageSize: 20 } })
      .then(data => {
        if (!valid()) return;
        if (!Array.isArray(data.rows) || !Array.isArray(data.summary?.byService) || !Number.isSafeInteger(data.summary.paidCents)) throw Error('bad contract');
        setLedger({ key, data });
      })
      .catch(() => { if (valid()) { setLedger(null); setFailure({ key, message: 'PMS 今日流水读取失败，PMS 收款金额未获取，请重试' }); } });
    return () => { alive = false; };
  }, [key]);

  useEffect(() => {
    let alive = true;
    setMis(null);
    request<unknown>({ url: '/fees/mis/today', query: { communityId: undefined } })
      .then((raw) => { if (!alive) return; const today = normalizeMisToday(raw); setMis({ key: misKey, today, todayMissing: today === null }); })
      .catch(() => { if (alive) setMis({ key: misKey, today: null, todayMissing: true }); });
    return () => { alive = false; };
  }, [misKey]);

  // 今日收款清单：按 date 分页取，每页 10 条；换页时保留上一页内容，避免卡片高度跳动。
  useEffect(() => {
    let alive = true;
    const targetPage = recent && recent.key === misKey ? recentPage : 1;
    setRecent((prev) => (prev && prev.key === misKey
      ? { ...prev, loading: true, missing: false }
      : { key: misKey, page: targetPage, rows: [], total: 0, houseCount: null, seenHouses: [], missing: false, loading: true, paged: true }));
    request<unknown>({ url: '/fees/mis/recent-payments', query: { date, page: targetPage, pageSize: 10 } })
      .then((raw) => {
        if (!alive) return;
        const parsed = normalizeRecent(raw);
        if (!parsed) throw Error('bad contract');
        setRecent((prev) => {
          const seen = new Set(prev && prev.key === misKey ? prev.seenHouses : []);
          for (const row of parsed.rows) if (row.address) seen.add(row.address);
          return { key: misKey, page: targetPage, rows: parsed.rows, total: parsed.total, houseCount: parsed.houseCount, seenHouses: [...seen], missing: false, loading: false, paged: parsed.paged };
        });
      })
      .catch(() => {
        if (!alive) return;
        setRecent((prev) => (prev && prev.key === misKey && prev.rows.length
          ? { ...prev, loading: false }
          : { key: misKey, page: targetPage, rows: [], total: 0, houseCount: null, seenHouses: [], missing: true, loading: false, paged: false }));
      });
    return () => { alive = false; };
  }, [misKey, recentPage]);



  const data = ledger?.key === key ? ledger.data : null;
  const error = failure?.key === key ? failure.message : '';
  const misReady = mis?.key === misKey ? mis : null;
  const today = misReady?.today ?? null;
  const todayMissing = misReady?.todayMissing ?? false;
  const recentReady = recent?.key === misKey ? recent : null;
  const recentRows = recentReady?.rows ?? [];
  const recentTotal = recentReady?.total ?? recentRows.length;
  const recentPaged = recentReady?.paged ?? false;
  const recentDisplayRows = recentPaged ? recentRows : recentRows.slice(0, 10);
  const recentMissing = recentReady?.missing ?? false;
  const recentLoading = recentReady?.loading ?? false;
  const recentPageNo = recentReady?.page ?? 1;
  const recentPages = Math.max(1, Math.ceil(recentTotal / 10));
  const recentHouseCount = recentReady?.houseCount ?? (recentReady?.seenHouses.length || new Set(recentDisplayRows.map((row) => row.address).filter(Boolean)).size);
  const recentClock = (row: RecentPayment) => {
    return formatBeijingDateTime(row.recordedAt, 'HH:mm');
  };
  const pmsPaidCents = data?.summary.paidCents ?? 0;
  const pmsFallback = misReady === null && data !== null;
  const repairStat = useMemo(() => {
    const list = visibleOrders ?? [];
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
  }, [visibleOrders]);

  const name = session.user?.name || session.user?.loginAccount || '管理员';
  const officeName = session.actingOffice?.name || (session.access?.scopeAll ? '全部管理处' : '');

  const todoRows: Array<{ icon: IconName; tone: string; t: string; d: string; n: number; to: string }> = [
    { icon: 'kanban', tone: 'red', t: '待派单工单', d: '没有自动派出去的，要办公室派', n: repairStat.pending, to: '/work-orders?filter=created' },
    { icon: 'kanban', tone: 'blue', t: '待维修工接单', d: '已自动通知默认维修工，久没人接就改派', n: repairStat.accepting, to: '/work-orders?filter=pending_accept' },
    { icon: 'clock', tone: 'amber', t: '已超时工单', d: '超过要求完成时间仍未完工', n: repairStat.overdue, to: '/work-orders?filter=overdue' },
    { icon: 'check', tone: 'blue', t: '待业主验收', d: '可代业主验收或催业主确认', n: repairStat.review, to: '/work-orders?filter=done_pending_review' },
    { icon: 'box', tone: 'amber', t: '等材料的工单', d: '到料后继续维修', n: repairStat.material, to: '/work-orders?filter=waiting_material' },
  ];

  const misValue = (value: number, suffix = '') => todayMissing ? <span className="erp-todo">待接口</span> : <>{money(value / 100)}{suffix}</>;
  const dataAsOfDate = today?.dataAsOf ? new Date(today.dataAsOf) : null;
  const dataAsOfClock = dataAsOfDate && !Number.isNaN(dataAsOfDate.getTime())
    ? dataAsOfDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
    : null;
  const mirrorStale = !!dataAsOfDate && !Number.isNaN(dataAsOfDate.getTime()) && Date.now() - dataAsOfDate.getTime() > 15 * 60_000;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>今日工作</h1>
          <p>{formatBeijingDateTime(new Date(), 'YYYY 年 M 月 D 日 ddd')}{officeName ? ` · ${officeName}` : ''} · 实时数据来自正式库（MIS 收款 + PMS 流水）</p>
          {dataAsOfClock ? <p style={{ margin: '4px 0 0', fontSize: 13, color: mirrorStale ? 'var(--warn)' : 'var(--muted)' }}>数据截至 {dataAsOfClock}{mirrorStale ? ' · 已滞后，镜像同步异常' : '（MIS 镜像）'}</p> : null}
        </div>
        <div className="act">
          <button className="btn" onClick={() => nav('/work-orders?new=1')}><Icon name="plus" size={18} />登记报修</button>
          <button className="btn p" onClick={() => nav('/cashier')}><Icon name="cash" size={18} />收费办理</button>
        </div>
      </div>

      {orderFailure ? <div role="alert" className="note">{orderFailure}<button className="btn" onClick={() => setOrdersRetry(n => n + 1)}>重试工单</button></div> : null}
      {error ? <div role="alert" className="note">{error}<button className="btn" onClick={() => setRetry(n => n + 1)}>重试PMS流水</button></div> : null}

      <div className="erp-today-kpis" aria-label="今日工作指标">
        <div className="erp-kpi">
          <div className="k">今日实收</div>
          {misReady === null && !pmsFallback ? <div className="v money">读取中…</div> : todayMissing ? <div className="v money"><span className="erp-todo">待接口</span></div> : pmsFallback ? <div className="v money" data-testid="today-income">{money(pmsPaidCents / 100)}</div> : <div className="v money" data-testid="today-income">{money((today?.paidCents ?? 0) / 100)}</div>}
          {pmsFallback ? <small className="erp-kpi-sub">MIS 读取中 · 暂显示 PMS 收款</small> : todayMissing ? <small className="erp-kpi-sub">MIS 今日统计接口未就绪，未用 0 代替</small> : <small className="erp-kpi-sub">MIS 当日口径 · {today?.paidHouses ?? 0} 户</small>}
          {pmsPaidCents > 0 ? <small className="erp-kpi-sub erp-kpi-pms">PMS 收款 {money(pmsPaidCents / 100)}</small> : null}
        </div>
        <div className="erp-kpi"><div className="k">退款</div><div className="v money">{misReady === null ? (pmsFallback ? money((data?.summary.refundedCents ?? 0) / 100) : '读取中…') : todayMissing ? <span className="erp-todo">待接口</span> : misValue(today?.refundedCents ?? 0)}</div></div>
        <div className="erp-kpi">
          <div className="k">收款笔数</div>
          <div className="v">{misReady === null ? (pmsFallback ? `${data?.summary.paidCount ?? 0} 笔` : '读取中…') : todayMissing ? <span className="erp-todo">待接口</span> : `${today?.paidCount ?? 0} 笔`}</div>
          {pmsFallback ? <small className="erp-kpi-sub">暂用 PMS 流水</small> : !todayMissing && misReady !== null ? <small className="erp-kpi-sub">MIS 当日 · {today?.paidHouses ?? 0} 户</small> : null}
        </div>
        <div className="erp-kpi"><div><div className="k">进行中工单</div><div className="v">{orderFailure ? '—' : visibleOrders === null ? '加载中…' : `${repairStat.active} 单`}</div></div></div>
      </div>

      <div className="erp-today-workspace">
        <div>
          <div className="card" style={{ padding: '18px 20px' }}>
            <div className="side-h"><Icon name="wallet" size={19} />主工作区</div>
            <p style={{ color: 'var(--ink2)', margin: '12px 0' }}>{name} · {officeName || '本账号范围'}</p>
            <p>MIS 当日收款、PMS 新登记收款分开显示；源 MIS 历史缴费另查。</p>
            <button className="btn" onClick={() => nav('/bills')}><Icon name="home" size={18} />账单与待缴</button>
          </div>

          <TodayIncome key={misKey} date={date} />
        </div>

        <div>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="side-h" style={{ padding: '16px 18px 2px' }}><Icon name="alert" size={19} style={{ color: 'var(--warn)' }} />需要处理</div>
            <div className="rowList">
              {todoRows.map((r) => (
                <button key={r.t} className="lrow click" onClick={() => nav(r.to)}>
                  <div className={`li ic ${r.n ? r.tone : 'blue'}`}><Icon name={r.icon} /></div>
                  <div className="lt"><b>{r.t}</b><small>{r.d}</small></div>
                  <b style={{ fontSize: 20, color: r.n && (r.tone === 'red' || r.tone === 'amber') ? 'var(--dang)' : 'var(--ink)' }}>{orderFailure ? '—' : visibleOrders === null ? '…' : r.n}</b>
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
            <div className="side-h today-recent-head" style={{ padding: '16px 18px 2px' }}>
              <span><Icon name="receipt" size={19} style={{ color: 'var(--acc-t)' }} />今日收款清单</span>
              {recentLoading && recentRows.length > 0 ? <small className="muted">刷新中…</small> : null}
            </div>
            <div style={{ padding: '4px 18px 0' }}>
              {recentReady === null ? <div className="empty" style={{ padding: 28 }}>今日收款读取中…</div>
                : recentMissing ? (
                  <div className="erp-todo-block" style={{ margin: '12px 0' }}><span className="erp-todo">待接口</span><span>MIS 最近收款接口未就绪，未显示 0。</span><button className="btn sm" onClick={() => setRetryMis(n => n + 1)}>重试</button></div>
                ) : recentDisplayRows.length === 0 ? <div className="empty" style={{ padding: 28 }}>最近20笔中无收款项，请查看办理记录</div>
                  : (
                    <>
                      <div className="today-recent-cols" aria-hidden="true"><span>时间</span><span>房号</span><span>业主</span><span>渠道</span><span>金额</span></div>
                      <div className="today-recent-list" style={{ minHeight: recentPaged ? 520 : undefined }}>
                        {recentDisplayRows.map((row, index) => {
                          const clock = recentClock(row);
                          return (
                            <div key={row.paidAt + row.address + index} className="today-recent-row">
                              <span className="today-recent-time"><b>{row.paidAt ? row.paidAt.slice(5) : '日期未记录'}</b><small title="MIS记录更新时间（北京时间），非实际收款时刻">{clock ? '更新 ' + clock : '更新时间 —'}</small></span>
                              <span className="today-recent-addr" title={row.address || undefined}>{row.address || '房号未记录'}</span>
                              <span className="today-recent-owner" title={row.ownerName || undefined}>{row.ownerName || '—'}</span>
                              <span className="today-recent-channel">{channelLabel(row.channel)}</span>
                              <b className="today-recent-amount">{money(row.amountCents / 100)}</b>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
            </div>
            {recentReady !== null && !recentMissing && recentDisplayRows.length > 0 ? (
              <div className="today-recent-foot">
                <span className="muted">共 {recentTotal} 笔 · {recentHouseCount} 户（按同房号同日聚合）</span>
                {recentPaged && recentPages > 1 ? (
                  <span className="today-recent-pager">
                    <button className="btn sm" disabled={recentPageNo <= 1 || recentLoading} onClick={() => setRecentPage(Math.max(1, recentPageNo - 1))}>上一页</button>
                    <span className="muted">第 {recentPageNo} / {recentPages} 页</span>
                    <button className="btn sm" disabled={recentPageNo >= recentPages || recentLoading} onClick={() => setRecentPage(recentPageNo + 1)}>下一页</button>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
