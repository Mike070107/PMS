import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { auth, useSession } from '@/lib/auth';
import { money } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading } from '@/components/ui';
import { FeeTrendChart, FeeBreakdownChart } from '@/legacy/components/FeeReportCharts';
import './erp-reference-pages.css';

interface Breakdown { amountCents: number; count: number; share: number }
interface MethodRow extends Breakdown { method: string | null }
interface FeeRow extends Breakdown { feeCode: string; feeName: string }
interface CommunityRow extends Breakdown { communityId: number | null; communityName: string | null }
interface CashierRow extends Breakdown { cashier: string | null }
interface TrendRow { day?: string; bucket?: string; label?: string; amountCents: number; count: number }
interface Totals { netCents: number; chargedCents: number; refundedCents: number; receiptCount: number; houseCount: number; itemCount: number }
interface Report {
  range: { from: string; to: string; granularity: string }; totals: Totals; previous: Totals;
  growth: { netCents: number; receiptCount: number; houseCount: number };
  trend: TrendRow[]; byMethod: MethodRow[]; byFee: FeeRow[]; byCommunity: CommunityRow[]; byCashier: CashierRow[];
}

interface AggMetrics {
  total: number; completed: number; pendingReview: number; cancelled: number; active: number; overdue: number;
  avgHours: number | null; feeCents: number; pendingFeeCents: number; materialCostCents: number;
  avgRating: number | null; ratingCount: number;
}
interface WorkOrderRow extends AggMetrics { key: string; label: string }
interface WorkOrderReport { range: { from: string; to: string }; groupBy: WorkOrderGroupBy; summary: AggMetrics; rows: WorkOrderRow[] }
interface StaffRow extends AggMetrics {
  userId: number; name: string; phone: string | null; accountStatus: string; onDuty: boolean;
  skillLabels: string[]; canTakeOrders: boolean; completedInRange: number; activeNow: number;
}
interface StaffReport { range: { from: string; to: string }; summary: AggMetrics; staffCount: number; completedInRange: number; activeNow: number; rows: StaffRow[] }
interface StockRow {
  stockId: number; warehouseId: number; warehouseName: string; warehouseType: string; materialId: number;
  code: string; name: string; spec: string | null; category: string | null; unit: string; enabled: boolean;
  qty: number; safetyQty: number; low: boolean; unitCostCents: number; costSource: 'lot' | 'default'; amountCents: number;
}
interface StockReport {
  summary: { skuCount: number; warehouseCount: number; lowCount: number; totalQtyRows: number; totalAmountCents: number };
  byWarehouse: Array<{ warehouseId: number; warehouseName: string; skuCount: number; lowCount: number; amountCents: number }>;
  rows: StockRow[];
}
interface MaterialUsageRow {
  key: string; label: string; lines: number; orders: number; qty: number | null; unit: string | null;
  code: string | null; spec: string | null; category: string | null; amountCents: number;
}
interface MaterialUsageDetail {
  id: number; usedAt: string; orderNo: string; statusLabel: string; assigneeName: string; communityName: string;
  name: string; code: string; spec: string | null; unit: string; qty: number; amountCents: number;
}
interface MaterialUsageReport {
  range: { from: string; to: string }; groupBy: MaterialUsageGroupBy;
  summary: { lines: number; orders: number; qty: number; amountCents: number };
  rows: Array<MaterialUsageRow | MaterialUsageDetail>; truncated: boolean;
}

type TabKey = 'fees' | 'work-orders' | 'stock' | 'material-usage' | 'staff';
type WorkOrderGroupBy = 'day' | 'assignee' | 'community' | 'repairType' | 'status';
type MaterialUsageGroupBy = 'detail' | 'day' | 'assignee' | 'material' | 'warehouse' | 'community';
type ExportKind = 'fees' | 'work-orders' | 'staff' | 'stock' | 'material-usage';

const TABS: Array<[TabKey, string, IconName]> = [
  ['fees', '收费', 'cash'],
  ['work-orders', '工单', 'kanban'],
  ['stock', '库存', 'box'],
  ['material-usage', '材料使用', 'layers'],
  ['staff', '人员', 'users'],
];
const WO_GROUP_LABELS: Record<WorkOrderGroupBy, string> = { day: '按天', assignee: '按责任人', community: '按小区', repairType: '按维修类型', status: '按状态' };
const MU_GROUP_LABELS: Record<MaterialUsageGroupBy, string> = { detail: '逐条明细', day: '按天', assignee: '按责任人', material: '按材料', warehouse: '按仓库', community: '按小区' };
const PM_LABEL: Record<string, string> = { cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行', pos: '刷卡', transfer: '转账', other: '其他' };
const fmtD = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const firstOfMonth = () => fmtD(new Date()).slice(0, 8) + '01';
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return fmtD(d); };
const yuan = (cents: number) => money((Number(cents) || 0) / 100);
const avg = (v: number | null) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Math.round(v * 10) / 10));

function Growth({ v }: { v: number }) {
  if (!isFinite(v) || v === 0) return <span className="muted" style={{ fontSize: 16 }}>持平</span>;
  const up = v > 0;
  return <span style={{ fontSize: 16, color: up ? 'var(--ok)' : 'var(--dang)' }}>{up ? '▲' : '▼'} {Math.abs(Math.round(v * 100))}%</span>;
}

function Kpi({ icon, tone, label, val, note }: { icon: IconName; tone: string; label: string; val: string; note?: ReactNode }) {
  return (
    <div className="stat">
      <div className={`ic ${tone}`} style={{ width: 44, height: 44 }}><Icon name={icon} /></div>
      <div className="v" style={{ fontSize: 22 }}>{val}</div>
      <div className="k">{label}{note ? <> · {note}</> : null}</div>
    </div>
  );
}

function Section({ title, icon, right, children }: { title: string; icon: IconName; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card erp-report-trend" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="secTitle" style={{ margin: 0 }}><Icon name={icon} size={18} />{title}</h2>
        {right ? <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div> : null}
      </div>
      <div className="erp-report-table" style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/** 分析看板：收费 / 工单 / 库存 / 材料使用 / 人员，全部只读；导出走后端 exceljs。 */
export default function Reports() {
  const session = useSession();
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(fmtD(new Date()));
  const [communityId, setCommunityId] = useState<number | 0>(0);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<TabKey>('fees');
  const [woGroupBy, setWoGroupBy] = useState<WorkOrderGroupBy>('day');
  const [woData, setWoData] = useState<WorkOrderReport | null>(null);
  const [woErr, setWoErr] = useState('');
  const [staffData, setStaffData] = useState<StaffReport | null>(null);
  const [staffErr, setStaffErr] = useState('');
  const [stockData, setStockData] = useState<StockReport | null>(null);
  const [stockErr, setStockErr] = useState('');
  const [stockQ, setStockQ] = useState('');
  const [stockCategory, setStockCategory] = useState('');
  const [stockOnlyLow, setStockOnlyLow] = useState(false);
  const [muGroupBy, setMuGroupBy] = useState<MaterialUsageGroupBy>('detail');
  const [muData, setMuData] = useState<MaterialUsageReport | null>(null);
  const [muErr, setMuErr] = useState('');
  const [exporting, setExporting] = useState('');
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([session.generation, session.user?.id, session.actingTenant?.id, session.access?.scopeAll, session.access?.communityIds]);

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const load = () => {
    let alive = true;
    setData(null); setErr('');
    request<Report>({ url: '/fees/reports/summary', query: { from, to, communityId: communityId || undefined } })
      .then(r => { if (alive) setData(r); }).catch(() => { if (alive) setErr('报表读取失败，条件保留，请重试'); });
    return () => { alive = false; };
  };
  useEffect(load, [from, to, communityId, scope, revision]);

  useEffect(() => {
    if (tab !== 'work-orders') return;
    let alive = true;
    setWoData(null); setWoErr('');
    request<WorkOrderReport>({ url: '/reports/work-orders', query: { from, to, communityId: communityId || undefined, groupBy: woGroupBy } })
      .then(r => { if (alive) setWoData(r); }).catch(() => { if (alive) setWoErr('工单报表读取失败；需要「报表查询」查看权限'); });
    return () => { alive = false; };
  }, [tab, from, to, communityId, woGroupBy, scope]);

  useEffect(() => {
    if (tab !== 'staff') return;
    let alive = true;
    setStaffData(null); setStaffErr('');
    request<StaffReport>({ url: '/reports/staff', query: { from, to, communityId: communityId || undefined } })
      .then(r => { if (alive) setStaffData(r); }).catch(() => { if (alive) setStaffErr('人员报表读取失败；需要「报表查询」查看权限'); });
    return () => { alive = false; };
  }, [tab, from, to, communityId, scope]);

  useEffect(() => {
    if (tab !== 'stock') return;
    let alive = true;
    setStockData(null); setStockErr('');
    request<StockReport>({ url: '/reports/stock', query: { q: stockQ || undefined, category: stockCategory || undefined, onlyLow: stockOnlyLow ? '1' : undefined } })
      .then(r => { if (alive) setStockData(r); }).catch(() => { if (alive) setStockErr('库存报表读取失败；需要「报表查询」查看权限'); });
    return () => { alive = false; };
  }, [tab, stockQ, stockCategory, stockOnlyLow, scope]);

  useEffect(() => {
    if (tab !== 'material-usage') return;
    let alive = true;
    setMuData(null); setMuErr('');
    request<MaterialUsageReport>({ url: '/reports/material-usage', query: { from, to, communityId: communityId || undefined, groupBy: muGroupBy } })
      .then(r => { if (alive) setMuData(r); }).catch(() => { if (alive) setMuErr('材料领用报表读取失败；需要「报表查询」查看权限'); });
    return () => { alive = false; };
  }, [tab, from, to, communityId, muGroupBy, scope]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };

  async function download(kind: ExportKind, extra: Record<string, string | number | undefined>, fallback: string) {
    setExporting(kind); setErr('');
    try {
      const [{ apiBaseURL }] = await Promise.all([import('@/lib/api')]);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      }
      const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
      const token = auth.getToken(); if (token) headers.Authorization = 'Bearer ' + token;
      const tenant = auth.getActingTenant(); if (tenant) headers['x-acting-tenant-id'] = String(tenant.id);
      const office = auth.getActingOffice(); if (office) headers['x-acting-office-id'] = String(office.id);
      const path = kind === 'fees'
        ? '/fees/reports/summary/export?' + query.toString()
        : '/reports/export?' + new URLSearchParams({ report: kind, ...Object.fromEntries(query) }).toString();
      const res = await fetch(apiBaseURL + path, { headers });
      if (!res.ok) {
        let msg = '导出失败（HTTP ' + res.status + '）';
        try { const body = await res.json() as { message?: string } | null; if (body?.message) msg = body.message; } catch { /* 非 JSON 响应 */ }
        throw new Error(msg);
      }
      const disposition = res.headers.get('content-disposition') || '';
      const matched = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const filename = matched ? decodeURIComponent(matched[1]) : fallback + '.xlsx';
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      setErr(e instanceof Error && /[\u4e00-\u9fff]/.test(e.message) ? e.message : '导出失败，请重试');
    } finally { setExporting(''); }
  }

  const kpis: Array<{ icon: IconName; tone: string; label: string; val: string; growth?: number }> = data ? [
    { icon: 'cash', tone: 'green', label: '净收款', val: money(data.totals.netCents / 100), growth: data.growth.netCents },
    { icon: 'receipt', tone: 'blue', label: '收据数', val: String(data.totals.receiptCount), growth: data.growth.receiptCount },
    { icon: 'home', tone: 'blue', label: '收费户数', val: String(data.totals.houseCount), growth: data.growth.houseCount },
    { icon: 'refresh', tone: 'amber', label: '退款(红冲)', val: money(data.totals.refundedCents / 100) },
  ] : [];

  const Bars = ({ title, icon, rows }: { title: string; icon: IconName; rows: Array<{ key: string; name: string; amountCents: number; count: number; share: number }> }) => (
    <section className="card erp-report-breakdown">
      <h2 className="secTitle"><Icon name={icon} size={18} />{title}</h2>
      <FeeBreakdownChart loading={false} rows={rows.map(r => ({ ...r, share: Number.isFinite(r.share) ? Math.round(r.share * 100) : null }))} />
    </section>
  );

  const exportButton = (kind: ExportKind, extra: Record<string, string | number | undefined>, fallback: string, disabled: boolean) => (
    <button className="btn" disabled={disabled || exporting === kind} onClick={() => void download(kind, extra, fallback)}>
      <Icon name="file" />{exporting === kind ? '导出中…' : '导出 Excel'}
    </button>
  );

  const dateFilters = (
    <>
      <DateInput className="in" type="date" style={{ width: 150 }} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
      <span className="muted">至</span>
      <DateInput className="in" type="date" style={{ width: 150 }} value={to} min={from} max={fmtD(new Date())} onChange={(e) => setTo(e.target.value)} />
      <div className="chips">
        <button className="chip" onClick={() => preset(daysAgo(6), fmtD(new Date()))}>近7天</button>
        <button className="chip" onClick={() => preset(daysAgo(29), fmtD(new Date()))}>近30天</button>
        <button className="chip" onClick={() => preset(firstOfMonth(), fmtD(new Date()))}>本月</button>
      </div>
      <select className="in" style={{ width: 180, marginLeft: 'auto' }} value={communityId} onChange={(e) => setCommunityId(Number(e.target.value))}>
        <option value={0}>全部小区</option>
        {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </>
  );

  return (
    <div className="erp-reports">
      <div className="ph" style={{ marginBottom: 10 }}>
        <div><h1 style={{ fontSize: 22 }}>维修收费报表</h1><p>收费 / 工单 / 库存 / 材料使用 / 人员 · 只读 · 数字由服务端聚合</p></div>
      </div>

      <div className="chips" role="tablist" aria-label="分析看板分区" style={{ marginBottom: 12 }}>
        {TABS.map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={'chip ' + (tab === key ? 'on' : '')} onClick={() => setTab(key)}>
            <Icon name={icon} size={15} />{label}
          </button>
        ))}
      </div>

      {tab !== 'stock' ? <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{dateFilters}</div> : (
        <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="in" style={{ width: 220 }} value={stockQ} placeholder="搜索仓库 / 物料编码或名称" onChange={(e) => setStockQ(e.target.value)} />
          <input className="in" style={{ width: 150 }} value={stockCategory} placeholder="物料分类" onChange={(e) => setStockCategory(e.target.value)} />
          <label className="chips" style={{ alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={stockOnlyLow} onChange={(e) => setStockOnlyLow(e.target.checked)} />只看低于安全库存
          </label>
        </div>
      )}

      {err ? <div role="alert" className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginTop: 4 }}><Icon name="alert" />{err}<button className="btn" onClick={() => setRevision(n => n + 1)}>重试</button></div> : null}

      {tab === 'fees' && (data === null && !err ? <Loading /> : data ? (
        <>
          <div className="erp-report-kpis" style={{ marginTop: 4 }}>
            {kpis.map((k) => (
              <div key={k.label} className="stat">
                <div className={`ic ${k.tone}`} style={{ width: 44, height: 44 }}><Icon name={k.icon} /></div>
                <div className="v" style={{ fontSize: 22 }}>{k.val}</div>
                <div className="k">{k.label}{k.growth !== undefined ? <> · <Growth v={k.growth} /></> : null}</div>
              </div>
            ))}
          </div>

          <section className="card erp-report-trend" data-testid="reports-trend-chart" role="region" aria-label="收款趋势，金额单位元，含红冲负数">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 className="secTitle" style={{ margin: 0 }}><Icon name="chart" size={18} />收款趋势</h2>
              <div style={{ marginLeft: 'auto' }}>{exportButton('fees', { from, to, communityId: communityId || undefined }, `收费报表_${from}_${to}`, !data)}</div>
            </div>
            <FeeTrendChart loading={false} rows={data.trend.map(t => ({ bucket: t.label || t.bucket || t.day || '未标注日期', amountCents: t.amountCents, count: t.count }))} label={bucket => bucket} />
            <details><summary>查看趋势明细 · {data.trend.length} 个日期</summary>
              <div className="erp-report-table"><table><thead><tr><th>日期</th><th className="num">净收款（元）</th><th className="num">笔数</th></tr></thead><tbody>
                {data.trend.map((t, i) => <tr key={i}><td>{t.label || t.bucket || t.day || '未标注日期'}</td><td className="num">{money(t.amountCents / 100)}</td><td className="num">{t.count}</td></tr>)}
              </tbody></table></div>
            </details>
          </section>
          <div className="erp-report-breakdowns">
            <Bars title="按费项" icon="receipt" rows={data.byFee.map((r) => ({ key: r.feeCode, name: r.feeName, amountCents: r.amountCents, count: r.count, share: r.share }))} />
            <Bars title="按收款方式" icon="wallet" rows={data.byMethod.map((r) => ({ key: r.method || 'null', name: PM_LABEL[r.method || ''] || r.method || '未知', amountCents: r.amountCents, count: r.count, share: r.share }))} />
            {data.byCommunity.length > 1 ? <Bars title="按小区" icon="building" rows={data.byCommunity.map((r) => ({ key: String(r.communityId), name: r.communityName || '未分小区', amountCents: r.amountCents, count: r.count, share: r.share }))} /> : null}
            <Bars title="按收费员" icon="users" rows={data.byCashier.map((r) => ({ key: r.cashier || 'null', name: r.cashier || '未记名', amountCents: r.amountCents, count: r.count, share: r.share }))} />
          </div>
        </>
      ) : null)}

      {tab === 'work-orders' && (
        <>
          <div className="chips" style={{ margin: '12px 0' }}>
            {(Object.keys(WO_GROUP_LABELS) as WorkOrderGroupBy[]).map((key) => (
              <button key={key} className={'chip ' + (woGroupBy === key ? 'on' : '')} onClick={() => setWoGroupBy(key)}>{WO_GROUP_LABELS[key]}</button>
            ))}
          </div>
          {woErr ? <div role="alert" className="note2"><Icon name="alert" />{woErr}</div> : woData === null ? <Loading /> : (
            <>
              <div className="erp-report-kpis">
                <Kpi icon="kanban" tone="blue" label="工单数" val={String(woData.summary.total)} note={`完成 ${woData.summary.completed} · 进行中 ${woData.summary.active}`} />
                <Kpi icon="alert" tone="amber" label="超时" val={String(woData.summary.overdue)} note={`待验收 ${woData.summary.pendingReview}`} />
                <Kpi icon="cash" tone="green" label="工单收费" val={yuan(woData.summary.feeCents)} note={`材料成本 ${yuan(woData.summary.materialCostCents)}`} />
                <Kpi icon="chart" tone="blue" label="平均完成时长" val={avg(woData.summary.avgHours) + (woData.summary.avgHours === null ? '' : ' 小时')} note={`评价 ${woData.summary.ratingCount} 条`} />
              </div>
              <Section title={`工单统计 · ${WO_GROUP_LABELS[woData.groupBy]}`} icon="kanban" right={exportButton('work-orders', { from, to, communityId: communityId || undefined, groupBy: woData.groupBy }, `工单统计_${from}_${to}`, !woData.rows.length)}>
                <table><thead><tr><th>分组</th><th className="num">工单数</th><th className="num">已完成</th><th className="num">进行中</th><th className="num">待验收</th><th className="num">超时</th><th className="num">平均时长(h)</th><th className="num">收费（元）</th></tr></thead><tbody>
                  {woData.rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.total}</td><td className="num">{r.completed}</td><td className="num">{r.active}</td><td className="num">{r.pendingReview}</td><td className="num">{r.overdue}</td><td className="num">{avg(r.avgHours)}</td><td className="num">{yuan(r.feeCents)}</td></tr>)}
                  {!woData.rows.length && <tr><td colSpan={8} className="muted">当前筛选范围没有工单</td></tr>}
                </tbody></table>
              </Section>
            </>
          )}
        </>
      )}

      {tab === 'stock' && (
        <>
          {stockErr ? <div role="alert" className="note2"><Icon name="alert" />{stockErr}</div> : stockData === null ? <Loading /> : (
            <>
              <div className="erp-report-kpis">
                <Kpi icon="box" tone="blue" label="SKU 数" val={String(stockData.summary.skuCount)} note={`${stockData.summary.warehouseCount} 个仓库`} />
                <Kpi icon="alert" tone="amber" label="低于安全库存" val={String(stockData.summary.lowCount)} note={`有库存行 ${stockData.summary.totalQtyRows}`} />
                <Kpi icon="cash" tone="green" label="库存金额" val={yuan(stockData.summary.totalAmountCents)} />
                <Kpi icon="clipboard" tone="blue" label="仓库数" val={String(stockData.byWarehouse.length)} />
              </div>
              <Section title="按仓库" icon="building" right={exportButton('stock', { q: stockQ || undefined, category: stockCategory || undefined, onlyLow: stockOnlyLow ? '1' : undefined }, '库存清单', !stockData.rows.length)}>
                <table><thead><tr><th>仓库</th><th className="num">SKU 数</th><th className="num">低于安全</th><th className="num">金额（元）</th></tr></thead><tbody>
                  {stockData.byWarehouse.map((r) => <tr key={r.warehouseId}><td>{r.warehouseName}</td><td className="num">{r.skuCount}</td><td className="num">{r.lowCount}</td><td className="num">{yuan(r.amountCents)}</td></tr>)}
                </tbody></table>
              </Section>
              <Section title={`库存明细 · ${stockData.rows.length} 行`} icon="box">
                <table><thead><tr><th>物料</th><th>仓库</th><th className="num">数量</th><th className="num">安全库存</th><th className="num">单位成本（元）</th><th className="num">金额（元）</th></tr></thead><tbody>
                  {stockData.rows.map((r) => <tr key={r.stockId}><td>{r.name}<small className="rb-sub">{r.code}{r.spec ? ' · ' + r.spec : ''}</small></td><td>{r.warehouseName}</td><td className="num">{r.qty} {r.unit}</td><td className="num">{r.safetyQty}{r.low ? <small style={{ color: 'var(--warn)' }}> 低</small> : null}</td><td className="num">{yuan(r.unitCostCents)}</td><td className="num">{yuan(r.amountCents)}</td></tr>)}
                  {!stockData.rows.length && <tr><td colSpan={6} className="muted">当前筛选范围没有库存</td></tr>}
                </tbody></table>
              </Section>
            </>
          )}
        </>
      )}

      {tab === 'material-usage' && (
        <>
          <div className="chips" style={{ margin: '12px 0' }}>
            {(Object.keys(MU_GROUP_LABELS) as MaterialUsageGroupBy[]).map((key) => (
              <button key={key} className={'chip ' + (muGroupBy === key ? 'on' : '')} onClick={() => setMuGroupBy(key)}>{MU_GROUP_LABELS[key]}</button>
            ))}
          </div>
          {muErr ? <div role="alert" className="note2"><Icon name="alert" />{muErr}</div> : muData === null ? <Loading /> : (
            <>
              <div className="erp-report-kpis">
                <Kpi icon="layers" tone="blue" label="领用行数" val={String(muData.summary.lines)} note={`${muData.summary.orders} 张工单`} />
                <Kpi icon="box" tone="green" label="领用数量" val={String(muData.summary.qty)} />
                <Kpi icon="cash" tone="green" label="材料金额" val={yuan(muData.summary.amountCents)} />
                <Kpi icon="file" tone="amber" label="统计口径" val={MU_GROUP_LABELS[muData.groupBy]} note={muData.truncated ? '已截断' : '全量'} />
              </div>
              <Section title={`材料领用 · ${MU_GROUP_LABELS[muData.groupBy]}`} icon="layers" right={exportButton('material-usage', { from, to, communityId: communityId || undefined, groupBy: muData.groupBy }, `材料领用_${from}_${to}`, !muData.rows.length)}>
                {muData.groupBy === 'detail' ? (
                  <table><thead><tr><th>领用时间</th><th>工单</th><th>责任人</th><th>小区</th><th>物料</th><th className="num">数量</th><th className="num">金额（元）</th></tr></thead><tbody>
                    {(muData.rows as MaterialUsageDetail[]).map((r) => <tr key={r.id}><td>{r.usedAt}</td><td>{r.orderNo}</td><td>{r.assigneeName}</td><td>{r.communityName}</td><td>{r.name}<small className="rb-sub">{r.code}</small></td><td className="num">{r.qty} {r.unit}</td><td className="num">{yuan(r.amountCents)}</td></tr>)}
                  </tbody></table>
                ) : (
                  <table><thead><tr><th>分组</th><th className="num">领用行数</th><th className="num">工单数</th><th className="num">数量</th><th className="num">金额（元）</th></tr></thead><tbody>
                    {(muData.rows as MaterialUsageRow[]).map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.lines}</td><td className="num">{r.orders}</td><td className="num">{r.qty ?? '—'}{r.unit ? ' ' + r.unit : ''}</td><td className="num">{yuan(r.amountCents)}</td></tr>)}
                  </tbody></table>
                )}
              </Section>
            </>
          )}
        </>
      )}

      {tab === 'staff' && (
        <>
          {staffErr ? <div role="alert" className="note2"><Icon name="alert" />{staffErr}</div> : staffData === null ? <Loading /> : (
            <>
              <div className="erp-report-kpis">
                <Kpi icon="users" tone="blue" label="员工数" val={String(staffData.staffCount)} />
                <Kpi icon="kanban" tone="blue" label="区间完成" val={String(staffData.completedInRange)} />
                <Kpi icon="kanban" tone="amber" label="当前进行" val={String(staffData.activeNow)} />
                <Kpi icon="chart" tone="green" label="超时工单" val={String(staffData.summary.overdue)} note={`待验收 ${staffData.summary.pendingReview}`} />
              </div>
              <Section title="人员统计" icon="users" right={exportButton('staff', { from, to, communityId: communityId || undefined }, `人员统计_${from}_${to}`, !staffData.rows.length)}>
                <table><thead><tr><th>员工</th><th>状态</th><th>在岗</th><th className="num">工单数</th><th className="num">已完成</th><th className="num">进行中</th><th className="num">超时</th><th className="num">区间完成</th><th className="num">当前进行</th></tr></thead><tbody>
                  {staffData.rows.map((r) => <tr key={r.userId}><td>{r.name}<small className="rb-sub">{r.phone || '未留电话'}</small></td><td>{r.accountStatus}</td><td>{r.onDuty ? '在岗' : '离岗'}</td><td className="num">{r.total}</td><td className="num">{r.completed}</td><td className="num">{r.active}</td><td className="num">{r.overdue}</td><td className="num">{r.completedInRange}</td><td className="num">{r.activeNow}</td></tr>)}
                  {!staffData.rows.length && <tr><td colSpan={9} className="muted">当前筛选范围没有人员数据</td></tr>}
                </tbody></table>
              </Section>
            </>
          )}
        </>
      )}

      <div className="note2"><Icon name="alert" />口径：收费按实收时间（红冲计负）；工单/材料按创建时间，库存按仓库 × 物料当前结存；导出 Excel 使用与页面相同的筛选条件。</div>
    </div>
  );
}
