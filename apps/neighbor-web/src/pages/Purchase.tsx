import { useCallback, useEffect, useMemo, useState } from 'react';
import { PurchaseRequestStatus } from '@pms/shared-types';
import type { PurchaseRequestView } from '@pms/shared-types';
import { purchases } from '@pms/api-client';
import { legacyUrl } from '@/lib/legacy';
import { Btn, Card, Empty, ErrorNote, Field, Loading, Sheet, toast } from '@/components/ui';
import { ago, dayjs, money } from '@/lib/format';

type StageKey = 'draft' | 'office_review' | 'manager_review' | 'purchaser_review' | 'approved' | 'orders' | 'done';

const STAGES: Array<{ key: StageKey; title: string; who: string; status?: PurchaseRequestStatus }> = [
  { key: 'draft', title: '缺料 / 新申请', who: '维修工 · 办公室', status: PurchaseRequestStatus.DRAFT },
  { key: 'office_review', title: '办公室汇总', who: '办公室', status: PurchaseRequestStatus.OFFICE_REVIEW },
  { key: 'manager_review', title: '物业经理审批', who: '物业经理', status: PurchaseRequestStatus.MANAGER_REVIEW },
  { key: 'purchaser_review', title: '采购经理审批', who: '采购经理', status: PurchaseRequestStatus.PURCHASER_REVIEW },
  { key: 'approved', title: '待下单', who: '采购员', status: PurchaseRequestStatus.APPROVED },
  { key: 'orders', title: '在途', who: '供应商' },
  { key: 'done', title: '到货入库', who: '仓管', status: PurchaseRequestStatus.DONE },
];

/**
 * 采购流程：一条流水线，每一格是一个人的待办。
 * 「在途」原本对应采购单（已下单未到货），这一版还没接，如实标出来。
 */
export default function Purchase() {
  const [stage, setStage] = useState<StageKey>('manager_review');
  const [byStage, setByStage] = useState<Record<string, PurchaseRequestView[]> | null>(null);
  const [err, setErr] = useState('');
  const [checked, setChecked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<PurchaseRequestView | null>(null);
  const [rejecting, setRejecting] = useState<PurchaseRequestView | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      // 一次把流水线上每个环节都拉一遍：格子里要显示真实的待办数
      const statuses = STAGES.map((s) => s.status).filter(Boolean) as PurchaseRequestStatus[];
      const lists = await Promise.all(statuses.map((s) => purchases.listRequests({ status: s }).catch(() => [] as PurchaseRequestView[])));
      const map: Record<string, PurchaseRequestView[]> = {};
      statuses.forEach((s, i) => { map[s] = lists[i]; });
      setByStage(map);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '采购申请加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = STAGES.find((s) => s.key === stage)!;
  const rows = useMemo(() => {
    if (!current.status || !byStage) return [];
    return [...(byStage[current.status] ?? [])].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [byStage, current.status]);

  const countOf = (s: { status?: PurchaseRequestStatus }) => (s.status && byStage ? (byStage[s.status] ?? []).length : 0);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      setChecked([]);
      setRejecting(null);
      setReason('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (!byStage && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <h1>采购流程</h1>
          <p>申请 → 汇总 → 两级审批 → 下单 → 入库；点任一环节看该环节的待办</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}>刷新</button>
          <button className="btn" onClick={() => { window.location.href = legacyUrl('/inventory'); }}>新建采购申请</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="pipe">
        {STAGES.map((s) => (
          <button key={s.key} className={stage === s.key ? 'on' : ''} onClick={() => { setStage(s.key); setChecked([]); }}>
            <small>{s.title}</small>
            <b>{s.status ? countOf(s) : '—'}</b>
            <div className="who">{s.who}</div>
          </button>
        ))}
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line)' }}>
          <b>{current.title}</b>
          <span className="muted">{current.who}处理</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {stage === 'office_review' ? (
              <>
                <Btn size="sm" disabled={busy || checked.length < 2} onClick={() => void run(() => purchases.merge({ requestIds: checked }), '已合并，仍留在汇总环节')}>
                  合并勾选 ({checked.length})
                </Btn>
                <Btn size="sm" kind="p" disabled={busy || checked.length === 0} onClick={() => void run(() => purchases.submitToManager({ requestIds: checked }), '已提交物业经理')}>
                  提交经理
                </Btn>
              </>
            ) : null}
            {stage === 'manager_review' || stage === 'purchaser_review' ? (
              <Btn size="sm" kind="p" disabled={busy || checked.length === 0}
                onClick={() => {
                  const fn = stage === 'manager_review' ? purchases.managerApprove : purchases.purchaserApprove;
                  void run(async () => { for (const id of checked) await fn(id); }, `已通过 ${checked.length} 张`);
                }}>
                批量通过 ({checked.length})
              </Btn>
            ) : null}
            {stage === 'orders' ? (
              <Btn size="sm" onClick={() => { window.location.href = legacyUrl('/inventory'); }}>去现有页面下单 / 入库</Btn>
            ) : null}
          </div>
        </div>

        {stage === 'orders' ? (
          <Empty>「在途」这一格对应的是已下单未到货的采购单，接口在旧后台的库存与采购页，这一版还没接。<br />点右上角去现有页面处理。</Empty>
        ) : rows.length ? (
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>申请单</th>
                <th>材料</th>
                <th>来源</th>
                <th>申请人</th>
                <th style={{ textAlign: 'right' }}>预估金额</th>
                <th>提交时间</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.includes(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td onClick={() => setDetail(r)}><b>{r.requestNo}</b></td>
                  <td className="sub" style={{ maxWidth: 280 }} onClick={() => setDetail(r)}>
                    {r.items.map((i) => `${i.name} ×${i.qty}${i.unit || ''}`).join('、') || '—'}
                  </td>
                  <td className="sub" onClick={() => setDetail(r)}>{r.workOrderNo ? `工单 ${r.workOrderNo}` : r.reason || '办公室建单'}</td>
                  <td onClick={() => setDetail(r)}>{r.applicantName || '—'}</td>
                  <td style={{ textAlign: 'right' }} onClick={() => setDetail(r)}>{money((r.estTotalCents || 0) / 100)}</td>
                  <td className="muted" onClick={() => setDetail(r)}>{ago(r.createdAt)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {stage === 'manager_review' ? (
                      <>
                        <Btn size="sm" kind="d" disabled={busy} onClick={() => { setRejecting(r); setReason(''); }}>驳回</Btn>
                        <Btn size="sm" kind="p" disabled={busy} onClick={() => void run(() => purchases.managerApprove(r.id), '已通过，转采购经理')}>通过</Btn>
                      </>
                    ) : null}
                    {stage === 'purchaser_review' ? (
                      <>
                        <Btn size="sm" kind="d" disabled={busy} onClick={() => { setRejecting(r); setReason(''); }}>驳回</Btn>
                        <Btn size="sm" kind="p" disabled={busy} onClick={() => void run(() => purchases.purchaserApprove(r.id), '已通过，可下单')}>通过</Btn>
                      </>
                    ) : null}
                    {stage === 'draft' || stage === 'office_review' ? <Btn size="sm" onClick={() => setDetail(r)}>查看</Btn> : null}
                    {stage === 'approved' ? <Btn size="sm" onClick={() => { window.location.href = legacyUrl('/inventory'); }}>去下单</Btn> : null}
                    {stage === 'done' ? <Btn size="sm" onClick={() => setDetail(r)}>查看</Btn> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>这一环节没有待办</Empty>}
      </Card>

      <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
        审批环节跟随「系统设置 → 采购审批链」；金额低于阈值时该环节会自动跳过（服务端判定，这里显示的就是真实结果）。
      </p>

      {/* 申请详情 */}
      <Sheet open={!!detail} onClose={() => setDetail(null)} title={detail?.requestNo || ''} subtitle={detail ? `${detail.applicantName || '—'} · ${detail.createdAt ? dayjs(detail.createdAt).format('YYYY-MM-DD HH:mm') : ''}` : ''}>
        {detail ? (
          <>
            <div className="facts">
              <div><small>预估金额</small><b>{money((detail.estTotalCents || 0) / 100)}</b></div>
              <div><small>状态</small><b>{detail.status}</b></div>
              <div><small>来源</small><b>{detail.workOrderNo || detail.reason || '办公室建单'}</b></div>
              <div><small>下一步</small><b>{detail.nextStepLabel || '—'}</b></div>
            </div>
            <div className="sec-t">申请明细</div>
            <table className="t">
              <thead><tr><th>材料</th><th>规格</th><th style={{ textAlign: 'right' }}>数量</th></tr></thead>
              <tbody>
                {detail.items.map((i) => (
                  <tr key={i.lineId}>
                    <td>{i.name}</td>
                    <td className="sub">{i.spec || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{i.qty} {i.unit || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.steps?.length ? (
              <>
                <div className="sec-t" style={{ marginTop: 16 }}>审批链</div>
                <div className="tl">
                  {detail.steps.map((s) => (
                    <div key={s.key} className={`e ${s.state === 'current' ? 'cur' : ''}`}>
                      <b>{s.label}</b>
                      <div className="w">{s.state === 'done' ? '✓ 已通过' : s.state === 'current' ? '当前环节' : s.state === 'skipped' ? '跳过' : '等待'}{s.by ? ` · ${s.by}` : ''}{s.note ? ` · ${s.note}` : ''}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </Sheet>

      {/* 驳回 */}
      <Sheet open={!!rejecting} onClose={() => setRejecting(null)} title="驳回采购申请" subtitle={rejecting?.requestNo}>
        <Field label="驳回原因（必填，会通知申请人）">
          <textarea className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：金额超标、已有库存、规格不对" />
        </Field>
        <Btn kind="d" size="lg" disabled={busy || !reason.trim()}
          onClick={() => { if (rejecting) void run(() => purchases.reject(rejecting.id, { reason: reason.trim() }), '已驳回'); }}>
          {busy ? '提交中…' : '确认驳回'}
        </Btn>
      </Sheet>
    </>
  );
}
