import { formatBeijingDateTime } from '@pms/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { inventory, purchases, request } from '@pms/api-client';
import type { PurchaseOrderView } from '@pms/api-client/src/endpoints/inventory';
import { PurchaseRequestStatus } from '@pms/shared-types';
import type { MaterialView, PurchaseRequestView, WarehouseView } from '@pms/shared-types';
import { downloadPurchaseRequestForms } from '@legacy/lib/purchaseRequestForm';
import RequestComposer from '@/components/purchase/RequestComposer';
import Icon from '@/components/Icon';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { purchaseFormOf, requestSourceText, sourceAddressText } from '@/lib/purchase-form';
import { Btn, Card, Empty, ErrorNote, Field, Loading, Sheet, toast } from '@/components/ui';
import { ago, dayjs, money } from '@/lib/format';

type StageKey = 'office' | 'manager' | 'purchaser' | 'approved' | 'transit' | 'done' | 'rejected';
const S = PurchaseRequestStatus;
const STAGES: Array<{ key: StageKey; title: string; who: string; status?: PurchaseRequestStatus }> = [
  { key: 'office', title: '待汇总', who: '办公室', status: S.OFFICE_REVIEW },
  { key: 'manager', title: '经理审批', who: '物业经理', status: S.MANAGER_REVIEW },
  { key: 'purchaser', title: '采购审批', who: '采购部', status: S.PURCHASER_REVIEW },
  { key: 'approved', title: '待下单', who: '采购员', status: S.APPROVED },
  { key: 'transit', title: '在途', who: '仓管收货' },
  { key: 'done', title: '已完成', who: '已下单 / 已入库', status: S.DONE },
  { key: 'rejected', title: '已驳回', who: '申请人修改重提', status: S.REJECTED },
];
const STATUS_TEXT: Record<string, string> = {
  draft: '草稿', office_review: '待汇总', manager_review: '待经理审批', purchaser_review: '待采购审批',
  approved: '已批准，待下单', rejected: '已驳回', merged: '已并入其他申请', done: '已下单',
};
const PO_TEXT: Record<string, string> = { placed: '待到货', partial: '部分到货', received: '已收齐', closed: '已关闭' };
interface Supplier { id: number; name: string; contactName?: string | null; contactPhone?: string | null; enabled: boolean }

/**
 * 采购：一条流水线，每格是一个人的待办，点哪格就在哪格把事办完。
 * 新建申请 → 汇总 → 经理 / 采购审批（跟随系统设置的审批链，低于阈值自动跳过）→ 选供应商下单 → 到货入库。
 */
export default function Purchase() {
  const [stage, setStage] = useState<StageKey>('manager');
  const [byStatus, setByStatus] = useState<Record<string, PurchaseRequestView[]> | null>(null);
  const [orders, setOrders] = useState<PurchaseOrderView[]>([]);
  const [err, setErr] = useState('');
  const [checked, setChecked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState<PurchaseRequestView | null>(null);
  const [composing, setComposing] = useState(false);
  const [ordering, setOrdering] = useState<PurchaseRequestView | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrderView | null>(null);
  const [reject, setReject] = useState<{ req: PurchaseRequestView; lineId?: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const canEdit = can('inventory', 'edit');
  const session = useSession();
  /** 申购单抬头兜底：能追到来源工单时用那个工单所属管理处，纯办公室建单才用当前视角 */
  const fallbackAreaName = session.actingOffice?.name || (session.access?.offices?.length === 1 ? session.access.offices[0].name : '');
  const [params, setParams] = useSearchParams();
  // 库存页「申请采购」带 ?new=1 过来：直接打开新建申请（里面可一键带入低库存材料）
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setComposing(true);
    const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true });
  }, [params, setParams]);

  const load = useCallback(async () => {
    try {
      const statuses = STAGES.map((s) => s.status).filter(Boolean) as PurchaseRequestStatus[];
      const [lists, po] = await Promise.all([
        Promise.all(statuses.map((s) => purchases.listRequests({ status: s }).catch(() => [] as PurchaseRequestView[]))),
        inventory.listPurchaseOrders().catch(() => [] as PurchaseOrderView[]),
      ]);
      const map: Record<string, PurchaseRequestView[]> = {};
      statuses.forEach((s, i) => { map[s] = lists[i]; });
      setByStatus(map); setOrders(po); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : '采购数据加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const current = STAGES.find((s) => s.key === stage)!;
  const transit = useMemo(() => orders.filter((o) => o.status === 'placed' || o.status === 'partial').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [orders]);
  const rows = useMemo(() => (current.status && byStatus ? [...(byStatus[current.status] ?? [])].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) : []), [byStatus, current.status]);
  const countOf = (s: (typeof STAGES)[number]) => (s.key === 'transit' ? transit.length : s.status && byStatus ? (byStatus[s.status] ?? []).length : 0);

  /**
   * 审批环节导出 Excel：勾了就导勾选的，没勾就导本环节全部。
   * 一张申请一个工作表，版式沿用旧后台「下载申购单」的《材料申购单》，
   * 审批人可以直接打印签字，不用再手抄一遍。
   */
  const exportRequests = async (list: PurchaseRequestView[]) => {
    if (!list.length) { toast('没有可导出的申请'); return; }
    setExporting(true);
    try {
      await downloadPurchaseRequestForms(list.map((r) => purchaseFormOf(r, fallbackAreaName)), {
        fileName: list.length > 1 ? `材料申购单_${current.title}_${dayjs().format('YYYYMMDD')}` : undefined,
      });
      toast(list.length > 1 ? `已导出 ${list.length} 张申购单` : `已导出 ${list[0].requestNo}`);
    } catch (e) { toast(e instanceof Error ? e.message : '导出 Excel 失败'); }
    finally { setExporting(false); }
  };

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); setChecked([]); setReject(null); setReason(''); setDetail(null); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const toggle = (id: number) => setChecked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const approve = (r: PurchaseRequestView) => run(() => (r.status === S.MANAGER_REVIEW ? purchases.managerApprove(r.id) : purchases.purchaserApprove(r.id)), '已通过');

  if (!byStatus && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div><h1>采购</h1><p>申请 → 汇总 → 审批 → 下单 → 到货入库；点任一环节，在那一格把事办完</p></div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}><Icon name="refresh" size={16} />刷新</button>
          {canEdit ? <button className="btn p" onClick={() => setComposing(true)}><Icon name="plus" size={18} />新建采购申请</button> : null}
        </div>
      </div>
      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="pipe">
        {STAGES.map((s) => (
          <button key={s.key} className={stage === s.key ? 'on' : ''} onClick={() => { setStage(s.key); setChecked([]); }}>
            <small>{s.title}</small><b>{countOf(s)}</b><div className="who">{s.who}</div>
          </button>
        ))}
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line)' }}>
          <b>{current.title}</b><span className="muted">{current.who}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {stage === 'office' ? (
              <>
                <Btn size="sm" disabled={busy || checked.length < 2} onClick={() => void run(() => purchases.merge({ requestIds: checked }), '已合并成一张，仍在待汇总')}>合并勾选 ({checked.length})</Btn>
                <Btn size="sm" kind="p" disabled={busy || !checked.length} onClick={() => void run(() => purchases.submitToManager({ requestIds: checked }), '已提交下一步审批')}>汇总提交 ({checked.length})</Btn>
              </>
            ) : null}
            {stage === 'manager' || stage === 'purchaser' ? (
              <>
                <Btn size="sm" disabled={busy || exporting || !rows.length} onClick={() => void exportRequests(checked.length ? rows.filter((r) => checked.includes(r.id)) : rows)}>
                  <Icon name="download" size={15} />{exporting ? '导出中…' : checked.length ? `导出 Excel（勾选 ${checked.length}）` : `导出 Excel（全部 ${rows.length}）`}
                </Btn>
                <Btn size="sm" kind="p" disabled={busy || !checked.length} onClick={() => {
                  const fn = stage === 'manager' ? purchases.managerApprove : purchases.purchaserApprove;
                  void run(async () => { for (const id of checked) await fn(id); }, `已通过 ${checked.length} 张`);
                }}>批量通过 ({checked.length})</Btn>
              </>
            ) : null}
          </div>
        </div>

        {stage === 'transit' ? (
          transit.length ? (
            <table className="t">
              <thead><tr><th>采购单</th><th>供应商</th><th>材料</th><th style={{ textAlign: 'right' }}>金额</th><th>状态</th><th>下单时间</th><th /></tr></thead>
              <tbody>
                {transit.map((o) => (
                  <tr key={o.id} className="row">
                    <td><b>{o.orderNo}</b>{o.requestNo ? <div className="muted" style={{ fontSize: 13 }}>申请 {o.requestNo}</div> : null}</td>
                    <td>{o.supplierName || '—'}</td>
                    <td className="sub" style={{ maxWidth: 300 }}>{o.items.map((i) => `${i.name || '#' + i.materialId}×${i.qty}${i.unit || ''}`).join('、')}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(o.totalCents / 100)}</td>
                    <td><span className={`pill ${o.status === 'partial' ? 's-work' : 's-pend'}`}>{PO_TEXT[o.status]}</span></td>
                    <td className="muted">{ago(o.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>{canEdit ? <Btn size="sm" kind="p" onClick={() => setReceiving(o)}>到货入库</Btn> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>没有在途的采购单</Empty>
        ) : rows.length ? (
          <table className="t">
            <thead><tr>{['office', 'manager', 'purchaser'].includes(stage) ? <th style={{ width: 34 }} /> : null}<th>申请单</th><th>材料</th><th>原因 / 报修地址</th><th>申请人</th><th style={{ textAlign: 'right' }}>预估金额</th><th>提交</th><th style={{ textAlign: 'right' }}>操作</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row" onClick={() => setDetail(r)}>
                  {['office', 'manager', 'purchaser'].includes(stage) ? <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.includes(r.id)} onChange={() => toggle(r.id)} /></td> : null}
                  <td><b>{r.requestNo}</b></td>
                  <td className="sub" style={{ maxWidth: 280 }}>{r.items.map((i) => `${i.name}×${i.qty}${i.unit || ''}`).join('、') || '—'}</td>
                  <td className="sub" style={{ maxWidth: 240 }}>
                    {r.reason ? <div>{r.reason}</div> : null}
                    <div className={r.reason ? 'muted' : ''} style={r.reason ? { fontSize: 12.5 } : undefined}>{requestSourceText(r)}</div>
                  </td>
                  <td>{r.applicantName || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{money((r.estTotalCents || 0) / 100)}</td>
                  <td className="muted">{ago(r.createdAt)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {stage === 'manager' || stage === 'purchaser' ? (
                      <><Btn size="sm" disabled={exporting} title="导出 Excel 申购单" onClick={() => void exportRequests([r])}>导出</Btn> <Btn size="sm" kind="d" disabled={busy} onClick={() => { setReject({ req: r, label: '整张申请' }); setReason(''); }}>驳回</Btn> <Btn size="sm" kind="p" disabled={busy} onClick={() => void approve(r)}>通过</Btn></>
                    ) : null}
                    {stage === 'approved' && canEdit ? <Btn size="sm" kind="p" onClick={() => setOrdering(r)}>下单</Btn> : null}
                    {stage === 'rejected' && canEdit ? <Btn size="sm" onClick={() => void run(() => purchases.reopen(r.id), '已退回待汇总，改好后重新提交')}>修改重提</Btn> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>这一环节没有待办</Empty>}
      </Card>
      <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>审批环节跟随「系统设置 → 采购审批链」；金额低于阈值的环节服务端自动跳过，这里显示的就是真实结果。</p>

      {/* 申请详情 */}
      <Sheet open={!!detail} onClose={() => setDetail(null)} width={1020} title={detail?.requestNo || ''} subtitle={detail ? `${detail.applicantName || '—'} · ${detail.createdAt ? formatBeijingDateTime(detail.createdAt, 'YYYY-MM-DD HH:mm') : ''}` : ''}>
        {detail ? (
          <>
            <div className="facts">
              <div><small>状态</small><b>{STATUS_TEXT[detail.status] || detail.status}</b></div>
              <div><small>预估金额</small><b>{money((detail.estTotalCents || 0) / 100)}</b></div>
              <div><small>下一步</small><b>{detail.nextStepLabel || '—'}</b></div>
              <div><small>报修来源</small><b>{requestSourceText(detail)}</b></div>
            </div>
            {detail.reason ? <div className="note2" style={{ marginBottom: 12 }}><Icon name="file" />{detail.reason}</div> : null}
            {detail.rejectReason ? <div className="note2" style={{ marginBottom: 12, color: 'var(--dang)' }}><Icon name="alert" />驳回原因：{detail.rejectReason}</div> : null}
            <div className="sec-t">申请明细</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="t" style={{ minWidth: 880 }}>
                <thead><tr><th>材料</th><th>报修地址</th><th>报修时间</th><th>维修工</th><th>规格</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>预估单价</th><th /></tr></thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.lineId || i.name} style={i.rejectReason ? { opacity: 0.5 } : undefined}>
                      <td><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{i.photoUrl ? <img src={i.photoUrl} alt="" className="pr-thumb" /> : null}<div>{i.name}{!i.materialId ? <span className="tag warn" style={{ marginLeft: 6 }}>未关联SKU</span> : null}{i.rejectReason ? <div className="muted" style={{ fontSize: 13 }}>已驳回：{i.rejectReason}</div> : null}</div></div></td>
                      <td className="sub" style={{ minWidth: 150 }}>
                        {sourceAddressText(i) || '—'}
                        {i.sourceWorkOrderId ? (
                          <div>
                            <Link
                              to={`/work-orders?sel=${i.sourceWorkOrderId}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--acc)', fontSize: 13, textDecoration: 'underline', textUnderlineOffset: 2 }}
                            >查看工单详情 ↗</Link>
                          </div>
                        ) : null}
                      </td>
                      <td className="sub" style={{ whiteSpace: 'nowrap' }}>
                        {i.sourceReportedAt ? <><div>{formatBeijingDateTime(i.sourceReportedAt, 'YYYY-MM-DD')}</div><div className="muted" style={{ fontSize: 12.5 }}>{formatBeijingDateTime(i.sourceReportedAt, 'HH:mm')}</div></> : '—'}
                      </td>
                      <td>{i.sourceAssigneeName || <span className="muted">未指派</span>}</td>
                      <td className="sub">{i.spec || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{i.qty} {i.unit || ''}</td>
                      <td style={{ textAlign: 'right' }}>{i.estUnitCostCents ? money(i.estUnitCostCents / 100) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{(detail.status === S.MANAGER_REVIEW || detail.status === S.PURCHASER_REVIEW) && i.lineId && !i.rejectReason && detail.items.length > 1
                        ? <Btn size="sm" onClick={() => { setReject({ req: detail, lineId: i.lineId!, label: `「${i.name}」这一行` }); setReason(''); }}>驳回此行</Btn> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.steps?.length ? (
              <>
                <div className="sec-t" style={{ marginTop: 16 }}>审批链</div>
                <div className="tl">
                  {detail.steps.map((s) => (
                    <div key={s.key} className={`e ${s.state === 'current' ? 'cur' : ''}`}>
                      <b>{s.label}</b>
                      <div className="w">{s.state === 'done' ? '✓ 已完成' : s.state === 'current' ? '当前环节' : s.state === 'skipped' ? '跳过' : '等待'}{s.by ? ` · ${s.by}` : ''}{s.at ? ` · ${formatBeijingDateTime(s.at, 'MM-DD HH:mm')}` : ''}{s.note ? ` · ${s.note}` : ''}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Btn disabled={exporting} onClick={() => void exportRequests([detail])}><Icon name="download" size={15} />{exporting ? '导出中…' : '导出 Excel'}</Btn>
              {detail.status === S.MANAGER_REVIEW || detail.status === S.PURCHASER_REVIEW ? (
                <><Btn kind="p" disabled={busy} onClick={() => void approve(detail)}>通过</Btn><Btn kind="d" disabled={busy} onClick={() => { setReject({ req: detail, label: '整张申请' }); setReason(''); }}>驳回整张</Btn></>
              ) : null}
              {detail.status === S.APPROVED && canEdit ? <Btn kind="p" onClick={() => { setOrdering(detail); setDetail(null); }}>选供应商下单</Btn> : null}
              {detail.status === S.OFFICE_REVIEW && canEdit ? <Btn kind="p" disabled={busy} onClick={() => void run(() => purchases.submitToManager({ requestIds: [detail.id] }), '已提交下一步审批')}>汇总提交</Btn> : null}
              {detail.status === S.REJECTED && canEdit ? <Btn onClick={() => void run(() => purchases.reopen(detail.id), '已退回待汇总，改好后重新提交')}>修改重提</Btn> : null}
            </div>
          </>
        ) : null}
      </Sheet>

      <Sheet open={!!reject} onClose={() => setReject(null)} title={`驳回${reject?.label || ''}`} subtitle={reject?.req.requestNo}>
        <Field label="驳回原因（必填，会通知申请人）">
          <div className="chips" style={{ marginBottom: 6 }}>{['已有库存', '金额超标', '规格不对', '暂不需要'].map((t) => <button key={t} className="chip" onClick={() => setReason(t)}>{t}</button>)}</div>
          <textarea className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="写清楚为什么，申请人改起来才有方向" />
        </Field>
        <Btn kind="d" size="lg" disabled={busy || !reason.trim()} onClick={() => {
          if (!reject) return;
          const r = reject;
          void run(() => (r.lineId ? purchases.rejectItem(r.req.id, { lineId: r.lineId, reason: reason.trim() }) : purchases.reject(r.req.id, { reason: reason.trim() })), r.lineId ? '已驳回这一行，其余继续审批' : '已驳回');
        }}>{busy ? '提交中…' : '确认驳回'}</Btn>
      </Sheet>

      {composing ? <RequestComposer onClose={() => setComposing(false)} onCreated={(r) => { setComposing(false); void load(); setStage(STAGES.find((s) => s.status === r.status)?.key || 'office'); }} /> : null}
      {ordering ? <OrderForm req={ordering} onClose={() => setOrdering(null)} onDone={() => { setOrdering(null); void load(); setStage('transit'); }} /> : null}
      {receiving ? <ReceiveForm order={receiving} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); void load(); }} /> : null}
    </>
  );
}

/* ───────── 下单：选供应商，没关联 SKU 的行当场关联 ───────── */
function OrderForm({ req, onClose, onDone }: { req: PurchaseRequestView; onClose: () => void; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [materials, setMaterials] = useState<MaterialView[]>([]);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [newSup, setNewSup] = useState<{ name: string; contactName: string; contactPhone: string } | null>(null);
  const items = req.items.filter((i) => !i.rejectReason);
  const [lines, setLines] = useState(() => items.map((i) => ({ lineId: i.lineId || '', name: i.name, spec: i.spec || '', unit: i.unit || '', materialId: i.materialId ?? null as number | null, qty: i.qty, cost: i.estUnitCostCents ? String(i.estUnitCostCents / 100) : '' })));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    request<Supplier[]>({ url: '/suppliers' }).then((l) => setSuppliers(l.filter((s) => s.enabled !== false))).catch(() => setSuppliers([]));
    inventory.listMaterials().then((l) => setMaterials(l.filter((m) => m.enabled))).catch(() => undefined);
  }, []);
  const total = lines.reduce((s, l) => s + Math.round((Number(l.cost) || 0) * 100) * l.qty, 0);

  const addSupplier = async () => {
    if (!newSup?.name.trim()) { toast('填供应商名称'); return; }
    try {
      const s = await request<Supplier>({ method: 'POST', url: '/suppliers', data: { name: newSup.name.trim(), contactName: newSup.contactName || undefined, contactPhone: newSup.contactPhone || undefined } });
      setSuppliers((p) => [...(p ?? []), s]); setSupplierId(s.id); setNewSup(null);
    } catch (e) { toast(e instanceof Error ? e.message : '新增供应商失败'); }
  };
  const submit = async () => {
    if (!supplierId) { toast('选一个供应商'); return; }
    if (lines.some((l) => !l.materialId)) { toast('还有材料没关联SKU：在那一行选一个，入库才能记到库存'); return; }
    setBusy(true);
    try {
      // 申请里本来没关联 SKU 的行，先把关联写回申请单，留痕一致
      if (items.some((i, k) => !i.materialId && lines[k].materialId)) {
        await purchases.updateItems(req.id, {
          items: req.items.map((i) => {
            const l = lines.find((x) => x.lineId && x.lineId === i.lineId);
            return { lineId: i.lineId || '', materialId: l?.materialId ?? i.materialId, name: i.name, qty: i.qty, unit: i.unit, spec: i.spec, note: i.note, photoUrls: i.photoUrls, estUnitCostCents: i.estUnitCostCents };
          }),
        });
      }
      await request({ method: 'POST', url: '/purchase-orders', data: { requestId: req.id, supplierId, items: lines.map((l) => ({ materialId: l.materialId, qty: l.qty, unitCostCents: Math.round((Number(l.cost) || 0) * 100) })) } });
      toast('已下单，到货后在「在途」里入库'); onDone();
    } catch (e) { toast(e instanceof Error ? e.message : '下单失败'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={820} title={`下单 · ${req.requestNo}`} subtitle="选供应商，核对数量和单价；按 SKU 记账，到货时直接入库">
      {suppliers === null ? <Loading /> : (
        <>
          <Field label="供应商">
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="in" value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">选择供应商</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.contactPhone ? ` · ${s.contactPhone}` : ''}</option>)}
              </select>
              <Btn onClick={() => setNewSup({ name: '', contactName: '', contactPhone: '' })}><Icon name="plus" size={15} />新供应商</Btn>
            </div>
          </Field>
          {newSup ? (
            <div className="card" style={{ padding: 12, marginBottom: 12, display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
              <Field label="名称"><input className="in" value={newSup.name} onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} /></Field>
              <Field label="联系人"><input className="in" value={newSup.contactName} onChange={(e) => setNewSup({ ...newSup, contactName: e.target.value })} /></Field>
              <Field label="电话"><input className="in" value={newSup.contactPhone} onChange={(e) => setNewSup({ ...newSup, contactPhone: e.target.value })} /></Field>
              <div style={{ marginBottom: 14, display: 'flex', gap: 6 }}><Btn kind="p" onClick={() => void addSupplier()}>添加</Btn><Btn onClick={() => setNewSup(null)}>取消</Btn></div>
            </div>
          ) : null}
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>材料</th><th style={{ width: 110 }}>数量</th><th style={{ width: 130 }}>单价(元)</th><th style={{ textAlign: 'right' }}>小计</th></tr></thead>
              <tbody>
                {lines.map((l, k) => (
                  <tr key={l.lineId || k} style={{ cursor: 'default' }}>
                    <td>
                      <b>{l.name}</b><span className="sub">{l.spec || '—'}</span>
                      {!items[k].materialId ? (
                        <select className="in" style={{ height: 34, marginTop: 4, borderColor: l.materialId ? undefined : 'var(--dang)' }} value={l.materialId ?? ''} onChange={(e) => setLines((p) => p.map((x, i) => (i === k ? { ...x, materialId: e.target.value ? Number(e.target.value) : null } : x)))}>
                          <option value="">关联材料SKU（必选）</option>
                          {materials.map((m) => <option key={m.id} value={m.id}>{m.name}{m.spec ? ` ${m.spec}` : ''} · {m.code}</option>)}
                        </select>
                      ) : null}
                    </td>
                    <td><input className="in" type="number" min={0} step="any" style={{ height: 36 }} value={l.qty} onChange={(e) => setLines((p) => p.map((x, i) => (i === k ? { ...x, qty: Number(e.target.value) || 0 } : x)))} /></td>
                    <td><input className="in" type="number" min={0} step="0.01" style={{ height: 36 }} value={l.cost} onChange={(e) => setLines((p) => p.map((x, i) => (i === k ? { ...x, cost: e.target.value } : x)))} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{money((Number(l.cost) || 0) * l.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <span>合计 <b style={{ fontSize: 20 }}>{money(total / 100)}</b></span><span style={{ flex: 1 }} />
            <Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '确认下单'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ───────── 到货入库：选仓库，按实收数量入，单价可改 ───────── */
function ReceiveForm({ order, onClose, onDone }: { order: PurchaseOrderView; onClose: () => void; onDone: () => void }) {
  const [warehouses, setWarehouses] = useState<WarehouseView[] | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | ''>('');
  const [lines, setLines] = useState(() => order.items.map((i) => ({ ...i, recv: String(i.qty), cost: String(i.unitCostCents / 100) })));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    inventory.listWarehouses({ scope: 'visible' }).then((l) => {
      const ok = l.filter((w) => w.enabled);
      setWarehouses(ok);
      const pref = ok.find((w) => w.preferred) || ok[0];
      if (pref) setWarehouseId(pref.id);
    }).catch(() => setWarehouses([]));
  }, []);
  const submit = async () => {
    if (!warehouseId) { toast('选入库仓库'); return; }
    const items = lines.filter((l) => Number(l.recv) > 0).map((l) => ({ materialId: l.materialId, qty: Number(l.recv), unitCostCents: Math.round((Number(l.cost) || 0) * 100) }));
    if (!items.length) { toast('实收数量都是 0'); return; }
    setBusy(true);
    try { await inventory.createGoodsReceipt({ purchaseOrderId: order.id, warehouseId, items }); toast('已入库，库存和批次已记账'); onDone(); }
    catch (e) { toast(e instanceof Error ? e.message : '入库失败'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} width={760} title={`到货入库 · ${order.orderNo}`} subtitle={`${order.supplierName || ''} · 按实收数量入库，少到的下次再收`}>
      {warehouses === null ? <Loading /> : (
        <>
          <Field label="入库仓库">
            <select className="in" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">选择仓库</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.officeName ? ` · ${w.officeName}` : ''}</option>)}
            </select>
          </Field>
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>材料</th><th style={{ textAlign: 'right' }}>下单数</th><th style={{ width: 120 }}>实收</th><th style={{ width: 130 }}>单价(元)</th></tr></thead>
              <tbody>
                {lines.map((l, k) => (
                  <tr key={k} style={{ cursor: 'default' }}>
                    <td><b>{l.name || `#${l.materialId}`}</b><span className="sub">{l.spec || '—'}</span></td>
                    <td style={{ textAlign: 'right' }}>{l.qty}{l.unit || ''}</td>
                    <td><input className="in" type="number" min={0} step="any" style={{ height: 36 }} value={l.recv} onChange={(e) => setLines((p) => p.map((x, i) => (i === k ? { ...x, recv: e.target.value } : x)))} /></td>
                    <td><input className="in" type="number" min={0} step="0.01" style={{ height: 36 }} value={l.cost} onChange={(e) => setLines((p) => p.map((x, i) => (i === k ? { ...x, cost: e.target.value } : x)))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
            <Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '入库中…' : '确认入库'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}
