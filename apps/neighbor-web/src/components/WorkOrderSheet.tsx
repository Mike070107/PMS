import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { WorkOrderStatus, REPAIR_TYPE_OPTIONS } from '@pms/shared-types';
import type { RollbackPreview, TechnicianOption, WorkOrderDetail, WorkOrderStockOptions } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Btn, Card, ErrorNote, Field, Loading, Pill, Sheet, toast } from '@/components/ui';
import { ago, dayjs, dueText, isOverdue, money, stageOf, statusOf } from '@/lib/format';
import { useSession } from '@/lib/auth';
import MaterialPicker, { linesToPayload } from '@/components/MaterialPicker';
import type { MatLine } from '@/components/MaterialPicker';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';

type Tab = 'info' | 'tl' | 'mat' | 'maint';
type Flow =
  | null
  | 'dispatch'
  | 'intake'
  | 'finish'
  | 'material'
  | 'accept'
  | 'claim'
  | 'rate'
  | 'cancel'
  | 'void'
  | 'undo'
  | 'progress'
  | 'transfer'
  | 'urge';

const TABS: Array<[Tab, string]> = [
  ['info', '概况'],
  ['tl', '处理进度'],
  ['mat', '用料与收费'],
  ['maint', '养护单'],
];

const SLA_OPTIONS: Array<[number, string]> = [
  [2, '2 小时内'],
  [8, '今天内'],
  [24, '24 小时'],
  [72, '3 天内'],
];

const CANCEL_REASONS: Array<[string, string]> = [
  ['owner_cancel', '业主取消'],
  ['self_resolved', '已自行解决'],
  ['duplicate', '重复提交'],
  ['wrong_info', '填错了'],
  ['other', '其他'],
];

const ACTION_LABEL: Record<string, string> = {
  create: '报修登记',
  assign: '派单',
  accept: '维修工接单',
  claim: '认领接单',
  progress: '添加进度',
  complete: '登记完工',
  review: '业主验收',
  need_material: '标记缺料',
  cancel: '撤单',
  rollback: '撤回上一步',
  transfer_request: '退回办公室',
  urge_repair: '催办',
  void: '作废',
};

/**
 * 工单详情抽屉：设计稿的核心交互——不离开列表就能把一单处理完。
 * 每个状态只有一个主操作；「撤回上一步」常驻可见（先预览再确认）；撤单/作废等终止类折进「更多」。
 * 办公室可以自己接单、代维修工接单、代填完工与缺料，时间轴由后端记「办公室代填」。
 */
export default function WorkOrderSheet({
  id, onClose, onChanged,
}: {
  id: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('info');
  const [flow, setFlow] = useState<Flow>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const load = useCallback(async (wid: number) => {
    setLoading(true);
    setErr('');
    try {
      setDetail(await repairs.detail(wid));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '工单加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setFlow(null);
    setTab('info');
    setMoreOpen(false);
    if (id) void load(id);
  }, [id, load]);

  const afterAction = async (msg: string) => {
    toast(msg);
    setFlow(null);
    setMoreOpen(false);
    if (id) await load(id);
    onChanged();
  };

  if (!id) return null;
  const wo = detail?.workOrder;
  const req = detail?.request;

  const head = (
    <div className="l3" style={{ marginBottom: 10 }}>
      {wo ? <><Pill status={stageOf(wo)} /> {wo.urgent ? <span className="pill urg" style={{ marginLeft: 6 }}>紧急</span> : null}
        {isOverdue(wo) ? <span className="pill urg" style={{ marginLeft: 6 }}>已超时</span> : null}
        <span style={{ marginLeft: 8 }}>{wo.summaryContent || req?.content || ''}</span></> : null}
      <div className="tabs" style={{ marginTop: 12 }}>
        {TABS.map(([k, t]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>
    </div>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      subtitle={loading ? '加载中…' : wo ? `${wo.orderNo} · ${wo.sourceLabel || '物业登记'} · ${ago(wo.createdAt)}` : ''}
      title={wo?.summaryAddress || '工单详情'}
      headExtra={head}
    >
      {err ? <ErrorNote>{err}</ErrorNote> : null}
      {loading && !detail ? <Loading /> : null}
      {detail && wo ? (
        flow ? (
          <FlowPanel
            detail={detail}
            flow={flow}
            onCancel={() => setFlow(null)}
            onDone={afterAction}
          />
        ) : (
          <>
            <NextActions
              detail={detail}
              moreOpen={moreOpen}
              toggleMore={() => setMoreOpen((v) => !v)}
              onFlow={(f) => { setFlow(f); setMoreOpen(false); }}
            />
            {tab === 'info' ? <InfoTab detail={detail} /> : null}
            {tab === 'tl' ? <TimelineTab detail={detail} /> : null}
            {tab === 'mat' ? <MaterialTab detail={detail} onChanged={() => void afterAction('已更新')} /> : null}
            {tab === 'maint' ? <MaintTab detail={detail} /> : null}
          </>
        )
      ) : null}
    </Sheet>
  );
}

/* -------------------- 下一步操作 -------------------- */
function NextActions({
  detail, onFlow, moreOpen, toggleMore,
}: {
  detail: WorkOrderDetail;
  onFlow: (f: Flow) => void;
  moreOpen: boolean;
  toggleMore: () => void;
}) {
  const s = detail.workOrder.status;
  interface Cfg { t: string; main: [Flow, string] | null; sec: Array<[Flow, string]>; more: Array<[Flow, string]> }
  const cfg: Cfg = (() => {
    switch (s) {
      case WorkOrderStatus.CREATED:
        // 已按报修类型自动通知了默认维修工：和旧后台一样显示「待维修工接单」，主操作是改派
        if (stageOf(detail.workOrder) === 'pending_accept') {
          return { t: `已按工种自动派给 ${detail.workOrder.candidateIds?.length ?? 0} 位维修工，等其中一人接单`, main: ['dispatch', '改派维修工'], sec: [['claim', '我来接单'], ['intake', '更正录入'], ['progress', '补充信息']], more: [['cancel', '撤单'], ['void', '作废']] };
        }
        return { t: '待派单', main: ['dispatch', '派给维修工'], sec: [['claim', '我来接单'], ['intake', '更正录入'], ['progress', '补充信息']], more: [['cancel', '撤单'], ['void', '作废']] };
      case WorkOrderStatus.DISPATCHED:
        return { t: `已派给 ${detail.workOrder.assigneeName || '维修工'}，等接单`, main: ['accept', '代维修工接单'], sec: [['dispatch', '改派'], ['intake', '更正录入'], ['urge', '催一下'], ['undo', '撤回上一步']], more: [['material', '代登记缺料'], ['cancel', '撤单'], ['void', '作废']] };
      case WorkOrderStatus.IN_PROGRESS:
        return { t: `${detail.workOrder.assigneeName || '维修工'} 维修中`, main: ['finish', '登记完工 · 用料扣料'], sec: [['material', '登记缺料'], ['progress', '添加进度'], ['undo', '撤回上一步']], more: [['dispatch', '改派'], ['transfer', '退回办公室重派'], ['cancel', '撤单'], ['void', '作废']] };
      case WorkOrderStatus.WAITING_MATERIAL:
        return { t: '等材料到位（已退回工单池）', main: ['finish', '材料已到 · 登记完工'], sec: [['claim', '我来接回维修'], ['dispatch', '派给维修工'], ['material', '修改缺料清单'], ['undo', '撤回上一步']], more: [['cancel', '撤单'], ['void', '作废']] };
      case WorkOrderStatus.DONE_PENDING_REVIEW:
        return { t: '等业主验收', main: ['rate', '代业主验收'], sec: [['urge', '提醒业主'], ['progress', '添加进度'], ['undo', '撤回上一步']], more: [['void', '作废']] };
      case WorkOrderStatus.COMPLETED:
        return { t: '已完成', main: null, sec: [['progress', '补充维修记录'], ['undo', '撤回上一步']], more: [['void', '作废']] };
      default:
        return { t: statusOf(s).name, main: null, sec: [], more: [] };
    }
  })();

  return (
    <div className="next">
      <div className="k">下一步</div>
      <div className="t">{cfg.t}</div>
      <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {cfg.main ? <Btn kind="p" onClick={() => onFlow(cfg.main![0])}>{cfg.main[1]}</Btn> : null}
        {cfg.sec.map(([k, t]) => <Btn key={k} onClick={() => onFlow(k)}>{t}</Btn>)}
        {cfg.more.length ? (
          <div className="more" style={{ position: 'relative', marginLeft: 'auto' }}>
            <Btn kind="g" onClick={toggleMore}>更多 ▾</Btn>
            {moreOpen ? (
              <div className="menu">
                {cfg.more.map(([k, t]) => (
                  <button key={k} className={k === 'cancel' || k === 'void' ? 'd' : ''} onClick={() => onFlow(k)}>{t}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------- 概况 -------------------- */
function InfoTab({ detail }: { detail: WorkOrderDetail }) {
  const wo = detail.workOrder;
  const req = detail.request;
  return (
    <>
      <div className="facts">
        <div><small>负责人</small><b>{wo.assigneeName || <span style={{ color: 'var(--warn)' }}>未指派</span>}</b></div>
        <div><small>报修类型</small><b>{wo.repairTypeLabel || '—'}</b></div>
        <div><small>要求完成</small><b className={isOverdue(wo) ? 'over' : ''}>{dueText(wo.slaDueAt)}</b></div>
        <div><small>已用时</small><b>{ago(wo.createdAt).replace('前', '')}</b></div>
      </div>

      <div className="sec-t">报修信息</div>
      <dl className="kv" style={{ margin: '0 0 16px' }}>
        <dt>地址</dt><dd>{wo.summaryAddress || req?.addressText || '—'}</dd>
        <dt>问题</dt><dd>{req?.content || wo.summaryContent || '—'}</dd>
        {req?.originalContent && req.originalContent.trim() && req.originalContent.trim() !== (req?.content || '').trim() ? (
          <><dt>原始报修内容</dt><dd style={{ color: 'var(--muted-foreground)' }}>{req.originalContent}</dd></>
        ) : null}
        <dt>联系人</dt><dd>{req?.contactName || wo.contactName || '—'} · {req?.contactPhone || '—'}</dd>
        <dt>报修来源</dt><dd>{wo.sourceLabel || '—'}{wo.submittedByName ? `（${wo.submittedByName} 提交）` : ''}</dd>
        <dt>登记时间</dt><dd>{dayjs(wo.createdAt).format('YYYY-MM-DD HH:mm')}</dd>
      </dl>

      <div className="sec-t">派单匹配</div>
      <dl className="kv" style={{ margin: '0 0 16px' }}>
        <dt>匹配工单类型</dt>
        <dd>{wo.repairTypeLabel || (wo.repairType ? wo.repairType : <span style={{ color: 'var(--warn)' }}>未识别到类型 · 转办公室派单</span>)}</dd>
        <dt>匹配维修工种</dt>
        <dd>
          {wo.assigneeName
            ? `已派 ${wo.assigneeName}`
            : wo.candidateIds?.length
              ? `已按工种自动通知 ${wo.candidateIds.length} 位维修工，等其中一人接单`
              : <span style={{ color: 'var(--warn)' }}>没有匹配到维修工（该类型未配默认维修工或未识别类型），待办公室派单</span>}
        </dd>
      </dl>

      {(req?.attachments?.length || wo.photos?.length) ? (
        <>
          <div className="sec-t">现场照片</div>
          <div className="photos" style={{ marginBottom: 18 }}>
            {(req?.attachments ?? wo.photos ?? []).map((url, i) => (
              <a key={`${url}-${i}`} href={url} target="_blank" rel="noreferrer"><i style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover' }} /></a>
            ))}
          </div>
        </>
      ) : null}

      {detail.workOrder.missingMaterials?.length ? (
        <>
          <div className="sec-t">缺料清单</div>
          <table className="t" style={{ marginBottom: 16 }}>
            <thead><tr><th>材料</th><th>数量</th></tr></thead>
            <tbody>
              {detail.workOrder.missingMaterials.map((m, i) => (
                <tr key={i}><td>{m.name}{m.spec ? <span className="muted"> · {m.spec}</span> : null}</td><td>{m.qty} {m.unit || ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

/* -------------------- 进度 -------------------- */
function TimelineTab({ detail }: { detail: WorkOrderDetail }) {
  const logs = [...detail.logs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!logs.length) return <div className="empty">还没有处理记录</div>;
  return (
    <div className="tl">
      {logs.map((l, i) => (
        <div key={l.id} className={`e ${i === logs.length - 1 ? 'cur' : ''}`}>
          <b>{ACTION_LABEL[l.action] || l.action}</b>
          <span className="w" style={{ float: 'right' }}>{dayjs(l.createdAt).format('MM-DD HH:mm')}</span>
          <div className="w">
            {l.fromStatus && l.toStatus && l.fromStatus !== l.toStatus
              ? `${statusOf(l.fromStatus).name} → ${statusOf(l.toStatus).name}`
              : statusOf(l.toStatus).name}
            {l.operatorName ? ` · ${l.operatorName}` : ''}
          </div>
          {l.note ? <div className="w">{l.note}</div> : null}
          {l.attachments?.length ? (
            <div className="photos" style={{ marginTop: 6 }}>
              {l.attachments.map((u, k) => (
                <a key={k} href={u} target="_blank" rel="noreferrer"><i style={{ backgroundImage: `url(${u})`, backgroundSize: 'cover' }} /></a>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* -------------------- 用料与收费 -------------------- */
function MaterialTab({ detail, onChanged }: { detail: WorkOrderDetail; onChanged: () => void }) {
  const wo = detail.workOrder;
  const usages = detail.materialUsages ?? [];
  return (
    <>
      <div className="sec-t">已领用料<span className="r muted">领料即扣库存</span></div>
      {usages.length ? (
        <table className="t">
          <thead><tr><th>材料</th><th>仓库</th><th>数量</th><th /></tr></thead>
          <tbody>
            {usages.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.spec ? <span className="muted"> · {u.spec}</span> : null}</td>
                <td className="muted">{u.warehouseName}</td>
                <td>{u.qty} {u.unit}</td>
                <td style={{ textAlign: 'right' }}>
                  <Btn size="sm" kind="d" onClick={async () => {
                    try {
                      await repairs.removeUsedMaterial(wo.id, u.id);
                      toast('已退库');
                      onChanged();
                    } catch (e) { toast(e instanceof Error ? e.message : '退库失败'); }
                  }}>退库</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="empty" style={{ padding: 18 }}>还没有领料记录</div>}

      <div className="sec-t" style={{ marginTop: 18 }}>收费</div>
      <div className="kv">
        <dt>向业主收费</dt><dd>{wo.feeCents ? money(wo.feeCents / 100) : '未收费'}</dd>
        <dt>处理内容</dt><dd>{wo.repairContent || '—'}</dd>
        <dt>故障位置</dt><dd>{wo.faultLocation || '—'}</dd>
        <dt>备注</dt><dd>{wo.actionNote || '—'}</dd>
      </div>
      {detail.completionDraft ? (
        <div className="note" style={{ marginTop: 14 }}>{detail.completionDraft.notice}</div>
      ) : null}
    </>
  );
}

/* -------------------- 养护单 -------------------- */
function MaintTab({ detail }: { detail: WorkOrderDetail }) {
  const s = detail.workOrder.status;
  const ready = s === WorkOrderStatus.DONE_PENDING_REVIEW || s === WorkOrderStatus.COMPLETED;
  return (
    <>
      <div className="sec-t">房屋修理养护任务单</div>
      {ready ? (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            按这张工单开《房屋修理养护任务单》：已经开过的直接打开原来那张，不会重复开单。
          </p>
          <Btn kind="p" onClick={() => { window.location.href = `${import.meta.env.BASE_URL}maint?workOrderId=${detail.workOrder.id}`; }}>填养护单</Btn>
        </>
      ) : (
        <div className="empty">完工后可在这里生成养护单<br /><span style={{ fontSize: 14 }}>（定额、签字、打印都在本工单内完成）</span></div>
      )}
    </>
  );
}

/* -------------------- 操作面板 -------------------- */
function FlowPanel({
  detail, flow, onCancel, onDone,
}: {
  detail: WorkOrderDetail;
  flow: Flow;
  onCancel: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const wo = detail.workOrder;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await onDone(msg);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const shell = (title: string, body: ReactNode, foot?: ReactNode, danger?: boolean) => (
    <div className={`flow ${danger ? 'danger' : ''}`}>
      <h3>{title}<Btn size="sm" kind="g" onClick={onCancel}>取消</Btn></h3>
      {err ? <ErrorNote>{err}</ErrorNote> : null}
      {body}
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );

  if (flow === 'dispatch') return <DispatchFlow detail={detail} busy={busy} err={err} run={run} shell={shell} />;
  if (flow === 'intake') return <IntakeFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'finish') return <FinishFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'material') return <MaterialFlow detail={detail} busy={busy} run={run} shell={shell} />;

  if (flow === 'accept') {
    return shell('代维修工接单',
      <p className="sub">{wo.assigneeName || '该维修工'} 已电话确认接单？工单转「维修中」，负责人仍是 {wo.assigneeName || '他'}；时间轴记为「办公室代维修工确认接单」，操作人是你。</p>,
      <Btn kind="p" size="lg" disabled={busy} onClick={() => void run(() => repairs.accept(wo.id), '已代接单')}>确认代接单</Btn>);
  }
  if (flow === 'claim') {
    return shell(wo.status === WorkOrderStatus.WAITING_MATERIAL ? '我来接回维修' : '我来接单',
      <p className="sub">这张单的负责人会改成你本人，状态转「维修中」。之后由你登记完工和用料；需要时也能再改派给维修工。</p>,
      <Btn kind="p" size="lg" disabled={busy} onClick={() => void run(() => repairs.accept(wo.id), '已接单，负责人是你')}>确认接单</Btn>);
  }

  if (flow === 'rate') return <RateFlow detail={detail} busy={busy} run={run} shell={shell} />;

  if (flow === 'cancel') return <CancelFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'void') return <VoidFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'undo') return <UndoFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'progress') return <ProgressFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'transfer') return <TransferFlow detail={detail} busy={busy} run={run} shell={shell} />;
  if (flow === 'urge') return <UrgeFlow detail={detail} busy={busy} run={run} shell={shell} />;
  return null;
}

type ShellFn = (title: string, body: ReactNode, foot?: ReactNode, danger?: boolean) => ReactNode;
type RunFn = (fn: () => Promise<unknown>, msg: string) => Promise<void>;

function DispatchFlow({ detail, busy, err, run, shell }: { detail: WorkOrderDetail; busy: boolean; err: string; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [techs, setTechs] = useState<TechnicianOption[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [sla, setSla] = useState<number>(wo.slaDueAt ? 0 : 8);
  const [note, setNote] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    let alive = true;
    repairs.technicians(wo.communityId, wo.skill || undefined)
      .then((list) => {
        if (!alive) return;
        const sorted = [...list].sort((a, b) => a.openCount - b.openCount);
        setTechs(sorted);
        setPick(sorted[0]?.id ?? null);
      })
      .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : '维修工列表加载失败'); });
    return () => { alive = false; };
  }, [wo.communityId, wo.skill]);

  return shell(wo.assigneeName ? '改派维修工' : '派单',
    <>
      {loadErr ? <ErrorNote>{loadErr}</ErrorNote> : null}
      <div className="sec-t"><span className="step-n">1</span>维修工<span className="r muted">按在手单数排序</span></div>
      {techs === null ? <Loading text="加载维修工…" /> : techs.length === 0 ? (
        <div className="empty">这个工种下没有可派的维修工</div>
      ) : (
        <div className="workers">
          {techs.map((w) => (
            <button key={w.id} className={`wk ${pick === w.id ? 'on' : ''}`} onClick={() => setPick(w.id)}>
              <div className="av">{w.name.slice(0, 1)}</div>
              <div><b>{w.name}</b><small>{w.skills?.length ? w.skills.join(' / ') : '—'}</small></div>
              <div className="load">在手 {w.openCount}<div className="bar"><i style={{ width: `${Math.min(100, w.openCount * 18)}%` }} /></div></div>
            </button>
          ))}
        </div>
      )}

      <div className="sec-t"><span className="step-n">2</span>要求完成</div>
      <div className="chips" style={{ marginBottom: 14 }}>
        {SLA_OPTIONS.map(([h, label]) => (
          <button key={h} className={`chip ${sla === h ? 'on' : ''}`} onClick={() => setSla(h)}>{label}</button>
        ))}
        <button className={`chip ${sla === 0 ? 'on' : ''}`} onClick={() => setSla(0)}>沿用原时限</button>
      </div>

      <Field label="给维修工的话（选填）">
        <input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：业主下午 3 点后在家" />
      </Field>
    </>,
    <Btn kind="p" size="lg" disabled={busy || !pick}
      onClick={() => void run(() => repairs.assign(wo.id, { assigneeId: pick!, slaHours: sla || undefined, note: note || undefined }), '已派单，已通知到小程序')}>
      {busy ? '提交中…' : `确认派给 ${techs?.find((t) => t.id === pick)?.name || ''}`}
    </Btn>,
  );
}

function IntakeFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const req = detail.request;
  const { communities } = useAddressTree();
  const [content, setContent] = useState(req?.content || wo.summaryContent || '');
  const [repairType, setRepairType] = useState(wo.repairType || req?.repairType || '');
  const [contactName, setContactName] = useState(req?.contactName || wo.contactName || '');
  const [contactPhone, setContactPhone] = useState(req?.contactPhone || '');
  const [urgent, setUrgent] = useState(!!wo.urgent);
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [reason, setReason] = useState('');

  return shell('更正录入信息',
    <>
      <p className="note" style={{ marginTop: 0 }}>接单前可更正地址、报修类型、描述、联系人。改类型会按新类型重新匹配维修工并通知。</p>
      <Field label="报修地址" hint="不改就留空，保持原地址">
        <div style={{ fontSize: 13.5, marginBottom: 6, color: 'var(--muted-foreground)' }}>当前：{wo.summaryAddress || req?.addressText || '—'}</div>
        <HousePicker communities={communities} value={picked} placeholder="要改地址就在这里重选房号" onPick={setPicked} onClear={() => setPicked(null)} />
      </Field>
      <Field label="报修类型">
        <div className="chips">
          {REPAIR_TYPE_OPTIONS.map((t) => (
            <button key={t.value} className={`chip ${repairType === t.value ? 'on' : ''}`} onClick={() => setRepairType(repairType === t.value ? '' : t.value)}>{t.label}</button>
          ))}
        </div>
      </Field>
      <Field label="故障描述">
        <textarea className="in" value={content} onChange={(e) => setContent(e.target.value)} />
      </Field>
      <Field label="联系人 / 电话">
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="in" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="联系人" style={{ flex: 1 }} />
          <input className="in" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="电话" style={{ flex: 1 }} />
        </div>
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 2px' }}>
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> 标记为紧急
      </label>
      <Field label="更正原因（选填）">
        <input className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：业主补充了准确房号" />
      </Field>
    </>,
    <Btn kind="p" size="lg" disabled={busy || !content.trim()}
      onClick={() => void run(() => repairs.updateWorkOrderIntake(wo.id, {
        communityId: picked?.communityId ?? wo.communityId,
        buildingId: picked?.buildingId,
        houseId: picked?.houseId,
        addressText: picked?.text,
        content: content.trim(),
        repairType: repairType || undefined,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        urgent,
        reason: reason.trim() || undefined,
      }), '已更正，已按新类型重新匹配维修工')}>
      {busy ? '提交中…' : '保存更正'}
    </Btn>,
  );
}

function ProxyBanner({ detail }: { detail: WorkOrderDetail }) {
  const me = useSession().user?.id;
  const wo = detail.workOrder;
  if (!wo.assigneeId || String(wo.assigneeId) === String(me ?? '')) return null;
  return <div className="note2" style={{ marginBottom: 12 }}>你在代 <b>{wo.assigneeName || '维修工'}</b> 填写，提交后时间轴会记「办公室代填」，操作人是你。</div>;
}

function FinishFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const draft = detail.completionDraft;
  // 位置、现象默认带出报修时登记的地址和描述（和小程序一致）：只是初值，现场看到的不一样就改，提交以改后的为准
  const [faultLocation, setFaultLocation] = useState(draft?.faultLocation || wo.faultLocation || detail.request?.addressText || '');
  const [faultSymptom, setFaultSymptom] = useState(draft?.faultSymptom || wo.faultSymptom || detail.request?.content || '');
  const [repairContent, setRepairContent] = useState(draft?.repairContent ?? wo.repairContent ?? '');
  const [fee, setFee] = useState(String((draft?.feeCents ?? wo.feeCents ?? 0) / 100));
  const [note, setNote] = useState('');
  // 撤回过的完工会带回上次清单作草稿，不用重选
  const [lines, setLines] = useState<MatLine[]>(() => (draft?.materials ?? []).map((m, i) => ({
    key: `d${i}`, materialId: m.materialId ?? undefined, warehouseId: m.warehouseId ?? undefined, name: m.name || '', unit: m.unit, qty: String(m.qty),
  })));
  const [idem] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));
  const feeCents = Math.round((Number(fee) || 0) * 100);

  return shell('登记完工 · 用料扣料',
    <>
      <ProxyBanner detail={detail} />
      <Field label="实际维修位置">
        <input className="in" value={faultLocation} onChange={(e) => setFaultLocation(e.target.value)} placeholder="例如：卫生间地漏" />
      </Field>
      <Field label="故障现象（选填）">
        <input className="in" value={faultSymptom} onChange={(e) => setFaultSymptom(e.target.value)} placeholder="已带出报修描述，可改" />
      </Field>
      <Field label="处理内容">
        <textarea className="in" value={repairContent} onChange={(e) => setRepairContent(e.target.value)} placeholder="换了什么、怎么处理的、试水/试电结果" />
      </Field>

      <div className="sec-t">用了哪些材料<span className="r muted">从材料SKU选的按所选仓扣库存</span></div>
      <MaterialPicker workOrderId={wo.id} mode="use" lines={lines} onChange={setLines} />

      <Field label="向业主收费（元）">
        <input className="in" type="number" min={0} value={fee} onChange={(e) => setFee(e.target.value)} />
      </Field>
      <Field label="维修备注（选填）">
        <input className="in" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="note">材料不够？先点「取消」改走「登记缺料」：有货的可以同时领用，没货的生成采购申请。照片和签字暂在小程序补。</div>
    </>,
    <Btn kind="p" size="lg" disabled={busy}
      onClick={() => {
        const parsed = linesToPayload(lines, 'use');
        if ('error' in parsed) { toast(parsed.error); return; }
        void run(() => repairs.complete(wo.id, {
          faultLocation, faultSymptom, repairContent,
          actionNote: note || undefined,
          feeCents,
          materials: parsed.rows,
          idempotencyKey: idem,
        }), '已登记完工，已扣料并通知业主验收');
      }}>
      {busy ? '提交中…' : '提交完工 · 通知业主验收'}
    </Btn>,
  );
}

function MaterialFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [missing, setMissing] = useState<MatLine[]>(() => (wo.missingMaterials ?? []).map((m, i) => ({
    key: `m${i}`, materialId: m.materialId ?? undefined, warehouseId: m.warehouseId ?? undefined, name: m.name, unit: m.unit, qty: String(m.qty),
  })));
  const [used, setUsed] = useState<MatLine[]>([]);
  const [showUsed, setShowUsed] = useState(false);
  const [note, setNote] = useState('');

  return shell('登记缺料 / 申请采购',
    <>
      <ProxyBanner detail={detail} />
      <p className="note" style={{ marginTop: 0 }}>提交后工单转「等材料」并退回工单池，同时自动生成采购申请进入审批。材料到了再派单或由人接回。</p>
      <div className="sec-t">缺哪些材料</div>
      <MaterialPicker workOrderId={wo.id} mode="missing" lines={missing} onChange={setMissing} />

      <div className="sec-t" style={{ marginTop: 14 }}>
        本次已经领用的有货材料<span className="r"><Btn size="sm" kind="g" onClick={() => setShowUsed((v) => !v)}>{showUsed ? '收起' : '有，登记一下'}</Btn></span>
      </div>
      {showUsed ? <MaterialPicker workOrderId={wo.id} mode="use" lines={used} onChange={setUsed} />
        : <div className="muted" style={{ fontSize: 13.5, marginBottom: 8 }}>例如先用了 2 米水管、阀门没货——水管在这里登记会同时扣库存。</div>}

      <Field label="原因 / 说明">
        <input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：原阀门锈死，仓库无货" />
      </Field>
    </>,
    <Btn kind="p" size="lg" disabled={busy}
      onClick={() => {
        const m = linesToPayload(missing, 'missing');
        if ('error' in m) { toast(m.error); return; }
        if (!m.rows.length) { toast('至少填一种缺的材料和数量'); return; }
        const u = linesToPayload(used, 'use');
        if ('error' in u) { toast(u.error); return; }
        void run(() => repairs.needMaterial(wo.id, {
          missingMaterials: m.rows,
          usedMaterials: u.rows.filter((r) => r.materialId),
          note: note || undefined,
        }), '已登记缺料，采购申请已生成');
      }}>
      {busy ? '提交中…' : '提交缺料'}
    </Btn>,
  );
}

function RateFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  return shell('代业主验收',
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)} style={{ fontSize: 26, color: n <= rating ? '#e2a23a' : '#d5d9d3' }}>★</button>
        ))}
      </div>
      <Field label="业主留言（选填）">
        <input className="in" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="电话回访记录" />
      </Field>
    </>,
    <Btn kind="p" size="lg" disabled={busy} onClick={() => void run(() => repairs.review(wo.id, { rating, comment: comment || undefined }), '验收完成')}>确认验收</Btn>,
  );
}

function CancelFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [code, setCode] = useState('owner_cancel');
  const [note, setNote] = useState('');
  return shell('撤单',
    <>
      <div className="chips" style={{ marginBottom: 14 }}>
        {CANCEL_REASONS.map(([k, t]) => (
          <button key={k} className={`chip ${code === k ? 'on' : ''}`} onClick={() => setCode(k)}>{t}</button>
        ))}
      </div>
      {code === 'other' ? (
        <Field label="具体原因（必填）"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      ) : null}
    </>,
    <Btn kind="d" size="lg" disabled={busy} onClick={() => void run(() => repairs.cancel(wo.id, { reasonCode: code, note: note || undefined }), '工单已撤单')}>确认撤单</Btn>,
    true,
  );
}

function VoidFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [reason, setReason] = useState('');
  return shell('作废工单',
    <>
      <p className="note" style={{ marginTop: 0 }}>作废后：已领用料自动退库；收费不计入统计；业主端显示为「已关闭」。</p>
      <Field label="作废原因（必填，至少 2 个字）">
        <input className="in" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </>,
    <Btn kind="d" size="lg" disabled={busy || reason.trim().length < 2}
      onClick={() => void run(() => repairs.voidWorkOrder(wo.id, { reason: reason.trim(), confirmReversal: true }), '工单已作废')}>确认作废</Btn>,
    true,
  );
}

function UndoFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [reason, setReason] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    repairs.rollbackPreview(wo.id)
      .then(setPreview)
      .catch((e) => setLoadErr(e instanceof Error ? e.message : '撤回预览加载失败'));
  }, [wo.id]);

  return shell('撤回上一步',
    <>
      {loadErr ? <ErrorNote>{loadErr}</ErrorNote> : null}
      {preview === null ? <Loading text="读取撤回影响…" /> : !preview.allowed ? (
        <ErrorNote>{preview.blockedReason || '当前状态不能撤回'}</ErrorNote>
      ) : (
        <div className="note" style={{ marginTop: 0 }}>
          撤销「{preview.actionLabel || preview.action}」：{preview.fromStatusLabel} → {preview.targetStatusLabel || '上一环节'}
          {preview.restoreAssigneeName ? `，负责人恢复为 ${preview.restoreAssigneeName}` : ''}
          {preview.willReturnMaterials ? `；退回材料 ${preview.materialTotalQty} 件` : ''}
          {preview.purchaseRequests?.length ? `；采购申请 ${preview.purchaseRequests.map((p) => p.requestNo).join('、')} 将被处理` : ''}
          {preview.reviewWillReverse ? '；业主评价会失效' : ''}
        </div>
      )}
      <Field label="撤回原因"><input className="in" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </>,
    <Btn kind="d" size="lg" disabled={busy || !preview?.allowed || !reason.trim()}
      onClick={() => void run(() => repairs.rollback(wo.id, { reason: reason.trim() }), '已撤回')}>确认撤回</Btn>,
    true,
  );
}

function ProgressFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [note, setNote] = useState('');
  return shell('添加进度',
    <Field label="内容"><textarea className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="现场情况、约定时间等，会记入时间轴" /></Field>,
    <Btn kind="p" size="lg" disabled={busy || !note.trim()}
      onClick={() => void run(() => repairs.addProgress(wo.id, { note: note.trim() }), '已记录进度')}>确认</Btn>,
  );
}

function TransferFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [note, setNote] = useState('');
  return shell('退回办公室重派',
    <>
      <p className="note" style={{ marginTop: 0 }}>工单会回到待派单，等待办公室重新指派。</p>
      <Field label="原因（必填）"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </>,
    <Btn kind="d" size="lg" disabled={busy || !note.trim()}
      onClick={() => void run(() => repairs.requestTransfer(wo.id, { note: note.trim() }), '已退回办公室')}>确认退回</Btn>,
    true,
  );
}

function UrgeFlow({ detail, busy, run, shell }: { detail: WorkOrderDetail; busy: boolean; run: RunFn; shell: ShellFn }) {
  const wo = detail.workOrder;
  const [note, setNote] = useState('');
  return shell('发送提醒',
    <>
      <p className="note" style={{ marginTop: 0 }}>提醒会通过微信和站内信发给相关的人；5 分钟内只发一条。</p>
      <Field label="正文（选填）"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </>,
    <Btn kind="p" size="lg" disabled={busy}
      onClick={() => void run(() => repairs.urgeRepair(wo.id, { note: note || undefined }), '已发送提醒')}>发送</Btn>,
  );
}
