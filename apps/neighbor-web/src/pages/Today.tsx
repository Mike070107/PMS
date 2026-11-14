import './erp-today.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { dayjs, formatBeijingDateTime, isActive, isOverdue, money, stageOf } from '@/lib/format';
import Icon from '@/components/Icon';
import { Sheet } from '@/components/ui';
import type { IconName } from '@/components/Icon';

interface Txn {
  id: number; txnNo: string; serviceType: string; status: string;
  amountCents: number; paymentMethod: string | null; createdAt: string;
}
type LedgerSummary = { paidCents: number; refundedCents: number; paidCount: number; byService: Array<{ serviceType: string; paidCents: number; paidCount: number }> };
type MisFeeRow = { name: string; feeCode?: string; amountCents: number; count: number; houseCount: number | null };
type MisToday = { paidCents: number; paidCount: number; refundedCents: number; paidHouses: number; byFee: MisFeeRow[]; dataAsOf?: string | null };
type RecentPayment = { paidAt: string; address: string; ownerName: string; amountCents: number; channel: string | null; billCount: number; recordedAt: string | null };
type MisState = { key: string; today: MisToday | null; todayMissing: boolean };
type FeeDetailRow = { id: string; recordedAt: string | null; roomNo: string; ownerName: string; channel: string | null; amountCents: number; billCount: number };
type FeeDetailState = { key: string; rows: FeeDetailRow[]; total: number; groupCount?: number; page: number; missing: boolean; loading: boolean };
type RecentState = { key: string; page: number; rows: RecentPayment[]; total: number; houseCount: number | null; seenHouses: string[]; missing: boolean; loading: boolean; paged: boolean };

const FEE_LABEL: Record<string, string> = { property: '物业费', parking: '停车', berth: '泊位费', other: '其他' };
const FEE_COLOR: Record<string, string> = { property: '#2f9e6e', parking: '#2f6fbe', berth: '#a5754a', other: '#7c8ba1' };
const FEE_COLOR_FALLBACK = ['#7c8ba1', '#2f9e6e', '#2f6fbe', '#a5754a'];
const feeCodeOf = (raw: unknown) => {
  const text = String(raw ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!text) return '';
  if (text.includes('propert') || text.includes('物业')) return 'property';
  if (text.includes('berth') || text.includes('泊位')) return 'berth';
  if (text.includes('parking') || text.includes('停车')) return 'parking';
  if (text.includes('other') || text.includes('其他')) return 'other';
  return text;
};
const feeLabelOf = (rawName: unknown, code: string) => {
  const name = String(rawName ?? '').trim();
  if (name && !/^(property|parking|berth|other)$/i.test(name)) return name;
  return FEE_LABEL[code] || FEE_LABEL[feeCodeOf(name)] || '其他';
};
const feeColorOf = (code: string, index: number) => FEE_COLOR[code] || FEE_COLOR_FALLBACK[index % FEE_COLOR_FALLBACK.length];

const CHANNEL_LABEL: Record<string, string> = { wechat: '微信', alipay: '支付宝', cash: '现金', bank: '银行', pos: '刷卡', transfer: '转账', other: '其他' };
const channelLabel = (raw: string | null) => (!raw ? '渠道未记录' : CHANNEL_LABEL[raw.toLowerCase()] || raw);

function normalizeMisToday(raw: unknown): MisToday | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const paidCents = Number(data.paidCents);
  if (!Number.isSafeInteger(paidCents) || paidCents < 0) return null;
  const byFee = Array.isArray(data.byFee) ? data.byFee.map((row: any) => {
    const code = feeCodeOf(row?.feeCode ?? row?.code ?? row?.feeType ?? row?.category ?? row?.feeName ?? row?.name);
    return {
      name: feeLabelOf(row?.feeName ?? row?.name ?? row?.category, code),
      feeCode: code || 'other',
      amountCents: Math.max(0, Number(row?.paidCents ?? row?.amountCents ?? 0) || 0),
      count: Number(row?.billCount ?? row?.count ?? row?.paidCount ?? 0) || 0,
      houseCount: Number.isFinite(Number(row?.houseCount)) && Number(row?.houseCount) >= 0 ? Number(row.houseCount) : null,
    };
  }) : [];
  return {
    paidCents,
    paidCount: Number(data.paidCount) || 0,
    refundedCents: Number(data.refundedCents) || 0,
    paidHouses: Number(data.paidHouses) || 0,
    byFee,
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

/** 今日分项收入环形图：纯 SVG 描边圆环，点击扇区看明细。 */
function FeeDonut({ rows, total, onPick }: { rows: Array<MisFeeRow & { color: string; share: number }>; total: number; onPick: (index: number) => void }) {
  const size = 210;
  const stroke = 20;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="erp-fee-donut-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="erp-fee-donut" role="img" aria-label="今日分项收入环形图">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line2)" strokeWidth={stroke} />
        {rows.filter((row) => row.amountCents > 0).map((row, index) => {
          const length = total ? (row.amountCents / total) * circumference : 0;
          const circle = (
            <circle
              key={row.name + index}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={row.color}
              strokeWidth={stroke}
              strokeDasharray={`${length} ${Math.max(0, circumference - length)}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="erp-fee-slice"
              onClick={() => onPick(index)}
            >
              <title>{`${row.name} ${money(row.amountCents / 100)} · ${row.count} 笔`}</title>
            </circle>
          );
          offset += length;
          return circle;
        })}
      </svg>
      <div className="erp-fee-donut-center"><b>{money(total / 100)}</b><small>今日合计</small></div>
    </div>
  );
}

/**
 * 今日工作：顶部三卡与分项收入用 MIS 当日口径（/fees/mis/today）；PMS 当日收款单独一行小字并列，两者不混算。
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
  const [feeDetail, setFeeDetail] = useState<MisFeeRow | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [detailRetry, setDetailRetry] = useState(0);
  const [detail, setDetail] = useState<FeeDetailState | null>(null);

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

  // 今日分项收入明细：点分类后按 category=feeCode 分页取当日收款
  useEffect(() => {
    if (!feeDetail) return undefined;
    let alive = true;
    const key = JSON.stringify([feeDetail.feeCode, feeDetail.name, date, detailPage, detailRetry]);
    setDetail((prev) => (prev && prev.key === key ? { ...prev, loading: true, missing: false } : { key, rows: [], total: 0, page: detailPage, missing: false, loading: true }));
    request<unknown>({ url: '/fees/mis/today/details', query: { category: feeDetail.feeCode || feeCodeOf(feeDetail.name), date, page: detailPage, pageSize: 20 } })
      .then((raw: any) => {
        if (!alive) return;
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.list) ? raw.list : [];
        const rows: FeeDetailRow[] = list.map((row: any, index: number) => ({
          id: String(row?.id ?? index),
          recordedAt: row?.recordedAt ? String(row.recordedAt) : row?.time ? String(row.time) : null,
          roomNo: String(row?.roomNo || row?.address || row?.addressText || ''),
          ownerName: String(row?.ownerName || row?.name || ''),
          channel: row?.channel ? String(row.channel) : row?.paymentMethod ? String(row.paymentMethod) : null,
          amountCents: Number(row?.amountCents ?? row?.paidCents) || 0,
          billCount: Number(row?.billCount ?? row?.count) || 1,
        }));
        setDetail({ key, rows, total: Number(Array.isArray(raw) ? rows.length : raw?.total) || rows.length, groupCount: Number(raw?.groupCount) || rows.length, page: detailPage, missing: false, loading: false });
      })
      .catch(() => { if (alive) setDetail({ key, rows: [], total: 0, page: detailPage, missing: true, loading: false }); });
    return () => { alive = false; };
  }, [feeDetail, date, detailPage, detailRetry]);

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
  const sumService = (types: string[]) => data?.summary.byService.filter((row) => types.includes(row.serviceType)).reduce((sum, row) => sum + row.paidCents, 0) ?? 0;
  const countService = (types: string[]) => data?.summary.byService.filter((row) => types.includes(row.serviceType)).reduce((sum, row) => sum + row.paidCount, 0) ?? 0;
  const legacyFeeRows: MisFeeRow[] = data ? [
    { name: '物业费', feeCode: 'property', amountCents: sumService(['mis_property']), count: countService(['mis_property']), houseCount: null },
    { name: '泊位费', feeCode: 'berth', amountCents: sumService(['mis_berth']), count: countService(['mis_berth']), houseCount: null },
    { name: '停车', feeCode: 'parking', amountCents: sumService(['parking_monthly']), count: countService(['parking_monthly']), houseCount: null },
    { name: '其他', feeCode: 'other', amountCents: sumService(['access_card']), count: countService(['access_card']), houseCount: null },
  ].filter((row) => row.amountCents !== 0 || row.count !== 0) : [];
  const feeRows = today?.byFee ?? (pmsFallback ? legacyFeeRows : []);
  const feeTotal = feeRows.reduce((sum, row) => sum + row.amountCents, 0);
  const feeBreakdown = feeRows.map((row, index) => ({ ...row, color: feeColorOf(row.feeCode || '', index), share: feeTotal ? Math.round((row.amountCents / feeTotal) * 1000) / 10 : 0 }));
  const openFeeDetail = (row: MisFeeRow) => { setFeeDetail(row); setDetailPage(1); setDetail(null); };
  const detailTotalPages = detail ? Math.max(1, Math.ceil((detail.groupCount ?? detail.total) / 20)) : 1;

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

          <div className="card" style={{ marginTop: 20, padding: '18px 20px' }}>
            <div className="side-h"><Icon name="chart" size={19} style={{ color: 'var(--acc-t)' }} />今日分项收入</div>
            <div style={{ marginTop: 12 }}>
              {misReady === null && !pmsFallback ? <p>分项收入读取中…</p> : todayMissing ? (
                <div className="erp-todo-block"><span className="erp-todo">待接口</span><span>今日分项收入接口未就绪，未显示 0。</span><button className="btn sm" onClick={() => setRetryMis(n => n + 1)}>重试</button></div>
              ) : feeRows.length === 0 ? <p style={{ color: 'var(--ink2)' }}>{pmsFallback ? 'PMS 今日暂无分项收入' : '今日暂无 MIS 分项收款'}</p> : (
                <div className="erp-fee-breakdown">
                  <FeeDonut rows={feeBreakdown} total={feeTotal} onPick={(index) => openFeeDetail(feeRows[index])} />
                  <div className="erp-fee-list">
                    {feeBreakdown.map((row, index) => (
                      <button type="button" className="erp-fee-item" key={row.name + index} onClick={() => openFeeDetail(feeRows[index])} title={`查看${row.name}今日收款明细`}>
                        <i className="erp-fee-dot" style={{ background: row.color }} />
                        <span className="erp-fee-name">{row.name}</span>
                        <span className="erp-fee-value">{money(row.amountCents / 100)}<small>{row.count} 笔{row.houseCount != null ? ` · ${row.houseCount} 户` : ''} · {row.share}%</small></span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
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

      <div className="note2" style={{ marginTop: 18 }}><Icon name="alert" />口径：今日实收 / 退款 / 收款笔数取 MIS 当日收款（北京时间，MIS 仅有日期精度）；PMS 当日收款单独标注、不混算。源 MIS 历史缴费另见收费流水。收款事实与外部写入核验分开，结果未知先查原单，不要重复收款。</div>

      {feeDetail ? (
        <Sheet open onClose={() => setFeeDetail(null)} width={760} title={`${feeDetail.name} · 今日收款明细`} subtitle={`${date} · ${detail && !detail.loading && !detail.missing ? `共 ${detail.total} 条` : '分项明细'}`}>
          {!detail || detail.loading ? <div style={{ padding: 28 }} className="muted">读取中…</div> : detail.missing ? (
            <div className="erp-todo-block">
              <span className="erp-todo">待接口</span>
              <span>分项收款明细接口未就绪，未显示 0。</span>
              <button className="btn sm" onClick={() => setDetailRetry((value) => value + 1)}>重试</button>
            </div>
          ) : detail.rows.length === 0 ? <div className="muted" style={{ padding: 36, textAlign: 'center' }}>该分类今天没有收款</div> : (
            <>
              <div className="intro-table-wrap">
                <table className="t usage-table">
                  <thead><tr><th>登记时间</th><th>房号</th><th>业主</th><th>渠道</th><th className="usage-num">金额</th><th className="usage-num">笔数</th></tr></thead>
                  <tbody>
                    {detail.rows.map((row) => (
                      <tr key={row.id}>
                        <td className="nw">{row.recordedAt ? <>{formatBeijingDateTime(row.recordedAt, 'MM-DD HH:mm')}<small className="muted"> 登记</small></> : '—'}</td>
                        <td>{row.roomNo || '—'}</td>
                        <td>{row.ownerName || '—'}</td>
                        <td>{channelLabel(row.channel)}</td>
                        <td className="usage-num"><b>{money(row.amountCents / 100)}</b></td>
                        <td className="usage-num">{row.billCount} 笔</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="erp-fee-detail-foot">
                <span className="muted">共 {detail.total} 条</span>
                {detailTotalPages > 1 ? (
                  <span className="today-recent-pager">
                    <button className="btn sm" disabled={detailPage <= 1} onClick={() => setDetailPage((value) => Math.max(1, value - 1))}>上一页</button>
                    <span className="muted">第 {detailPage} / {detailTotalPages} 页</span>
                    <button className="btn sm" disabled={detailPage >= detailTotalPages} onClick={() => setDetailPage((value) => value + 1)}>下一页</button>
                  </span>
                ) : null}
              </div>
            </>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
