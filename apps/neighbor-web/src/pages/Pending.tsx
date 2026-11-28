import { registrationTitle } from '@/components/cashier/RegistrationPermit';
import { formatBeijingDateTime } from '@pms/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accessCardIssuance, request } from '@pms/api-client';
import type { AccessCardReadiness } from '@pms/api-client';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import { can } from '@/lib/perm';
import { money } from '@/lib/format';
import { useSession } from '@/lib/auth';
import type { Intake } from '@/components/cashier/NewPlateCard';

const INTAKE_PERMISSIONS = ['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager'];

type ActionSummary = { at: string; action: string; userName?: string | null };
function RecentAction({ entry }: { entry?: ActionSummary }) {
  return entry ? <small>最近操作 · {formatBeijingDateTime(entry.at, 'MM-DD HH:mm')} · {entry.userName ? entry.userName + ' · ' : ''}{entry.action}</small> : null;
}
const nextStep: Record<string, string> = {
  office: '办公室核对资料并提交经理', manager: '经理核对申请后通过或退回', returned: '办公室按退回原因补正资料',
  upload: '补齐申请资料并提交', opening: '等待停车系统回执，可查看执行进度', blocked: '核对错误原因，在原申请继续办理',
  queued: '等待系统领取任务', running: '等待写入和回读结果', retry: '等待系统按计划重试',
  manual: '核对原流水和执行结果，处理后登记结果', failed: '核对失败原因，再重试原任务',
  rejected: '根据驳回原因办理退款或重新申请', dry_run: '核对演练结果后再正式办理',
  review: '经理审核收费金额与续期原因', awaiting_docs: '联系业主补交资料，再由办公室审核',
};
interface Execution {
  mode?: 'off' | 'dry-run' | 'on'; attempts?: number; nextAt?: string | null; lastError?: string | null;
  planned?: { vehicleId: string; previousEndDate: string; endDate: string } | null; finishedAt?: string | null;
  result?: { action?: string; systems?: string[]; endDate?: string | null } | null;
}
interface Txn {
  id: number; txnNo: string; serviceType: string; status: string; amountCents: number; createdAt: string;
  endDate: string | null; externalSyncStatus: string;
  snapshot?: { vehicle?: { plateNo?: string }; intake?: { id: number }; execution?: Execution; parking?: { systems?: Array<{ label: string }> };
    review?: { reason?: string; startDate?: string; endDate?: string; manualAmountCents?: number; standardAmountCents?: number; decisionReason?: string | null } } | null;
  startDate?: string | null; createdBy?: number | null;
}
type Mode = 'off' | 'dry-run' | 'on';

const ST: Record<string, { t: string; tag: string; tone: string }> = {
  queued: { t: '排队中', tag: 'acc', tone: 'blue' },
  running: { t: '执行中', tag: 'acc', tone: 'blue' },
  retry: { t: '等待自动重试', tag: 'warn', tone: 'amber' },
  manual: { t: '需人工处理', tag: 'dang', tone: 'red' },
  failed: { t: '多次失败', tag: 'dang', tone: 'red' },
  dry_run: { t: '演练（未写入）', tag: 'mute', tone: 'blue' },
  review: { t: '待经理审核', tag: 'warn', tone: 'amber' },
  rejected: { t: '已驳回', tag: 'dang', tone: 'red' },
  awaiting_docs: { t: '等业主资料', tag: 'warn', tone: 'amber' },
};
async function pendingPages<T extends { id: number }>(url: string, query: Record<string, string> = {}) {
  const rows: T[] = [];
  let beforeId: number | undefined;
  for (;;) {
    const batch: T[] = await request<T[]>({ url, query: { ...query, ...(beforeId ? { beforeId } : {}) } });
    rows.push(...batch);
    if (batch.length < 200) return rows;
    const last = batch[batch.length - 1].id;
    if (beforeId !== undefined && last >= beforeId) throw new Error('待办分页未能继续，请刷新');
    beforeId = last;
  }
}
const MODE: Record<Mode, string> = {
  on: '正式：收款后自动写入德立云，并回读核对',
  'dry-run': '演练：只读核对德立云并记下「将要写什么」，不写入。授权真车测试后切为正式',
  off: '已关闭：收款后不自动同步德立云',
};

/**
 * 待处理：执行层的真实状态（停车月租 → 德立云续期）+ 设备与现场助手异常。
 * 数据来自 /business/execution/pending；「重试」走 /business/transactions/:id/retry-sync（后端幂等：已是目标即成功，不会续两次）。
 */
export default function Pending() {
  useSession();
  const nav = useNavigate();
  const canViewIntakes = INTAKE_PERMISSIONS.some(key => can(key, 'view'));
  const canReviewIntakes = INTAKE_PERMISSIONS.some(key => can(key, 'edit'));
  const [intakes, setIntakes] = useState<Intake[] | null>(null);
  const [awaitingPayment, setAwaitingPayment] = useState<Intake[]>([]);
  const [awaitingSubmission, setAwaitingSubmission] = useState<Intake[]>([]);
  const [intakeError, setIntakeError] = useState('');
  const [intakeLoading, setIntakeLoading] = useState(canViewIntakes);
  const [intakeRefresh, setIntakeRefresh] = useState(0);
  useEffect(() => {
    if (!canViewIntakes) { setIntakes(null); setAwaitingPayment([]); setAwaitingSubmission([]); setIntakeError(''); setIntakeLoading(false); return; }
    let alive = true;
    let revision = 0;
    const loadIntakes = async () => {
      const current = ++revision;
      setIntakeLoading(true);
      try {
        const [rows, drafts, payments] = await Promise.all([
          pendingPages<Intake>('/vehicle-intakes', { status: 'submitted' }),
          pendingPages<Intake>('/vehicle-intakes', { status: 'waiting,reupload' }),
          pendingPages<Intake>('/vehicle-intakes', { status: 'approved', awaitingPayment: '1' }),
        ]);
        if (alive && current === revision) {
          setAwaitingPayment(payments.filter(i => i.kind === 'paid' && i.status === 'approved' && !i.transaction));
          setAwaitingSubmission(drafts.filter(i => i.status === 'waiting' || i.status === 'reupload'));
          setIntakes(rows.filter(row => row.status === 'submitted'));
          setIntakeError('');
        }
      } catch (e) {
        if (alive && current === revision) setIntakeError(e instanceof Error ? e.message : '待审核车牌读取失败');
      } finally {
        if (alive && current === revision) setIntakeLoading(false);
      }
    };
    void loadIntakes();
    const timer = setInterval(loadIntakes, 15000);
    window.addEventListener('focus', loadIntakes);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', loadIntakes); };
  }, [canViewIntakes, intakeRefresh]);
  const canViewFamily = ['family-cars', 'family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager'].some(key => can(key, 'view'));
  type ReviewGroup = { status: string; label: string; total: number; rows: { id: number; plate: string; roomKey: string; latestAction?: ActionSummary; lastError?: string | null }[] };
  const [familyGroups, setFamilyGroups] = useState<ReviewGroup[]>([]);
  const [familyError, setFamilyError] = useState('');
  const [familyLoaded, setFamilyLoaded] = useState(false);
  useEffect(() => {
    if (!canViewFamily) return;
    let revision = 0;
    async function refresh() {
      const turn = ++revision;
      try {
        const groups = await Promise.all([['office', '办公室审核'], ['manager', '经理审核'], ['returned', '已退回办公室'], ['upload', '待上传资料'], ['opening', '正在开通']].map(async ([status, label]) => {
          const rows = new Map<number, ReviewGroup['rows'][number]>();
          let total = 0;
          for (let page = 1; ; page++) {
            const result = await request<Pick<ReviewGroup, 'rows' | 'total'>>({ url: '/family-cars', query: { status, page, pageSize: 100 } });
            total = result.total;
            for (const item of result.rows) rows.set(item.id, item);
            if (page * 100 >= total || !result.rows.length) break;
          }
          return { status, label, rows: [...rows.values()], total };
        }));
        if (turn === revision) { const opening = groups.find(group => group.status === 'opening')!;
          const blocked = opening.rows.filter(item => item.lastError && !/等待|尚未释放/.test(item.lastError));
          const failedIds = new Set(blocked.map(item => item.id));
          setFamilyGroups([...groups.filter(group => group !== opening), ...[
            { status: 'opening', label: '正在开通', rows: opening.rows.filter(item => !failedIds.has(item.id)) },
            { status: 'blocked', label: '开通受阻', rows: blocked },
          ].map(group => ({ ...group, total: group.rows.length }))]); setFamilyError(''); setFamilyLoaded(true); }
      } catch { if (turn === revision) setFamilyError('亲情车待办读取失败'); }
    }
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => { ++revision; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [canViewFamily, intakeRefresh]);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [ready, setReady] = useState<AccessCardReadiness | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  // 收费类经理审核：新 key 或拆分前的旧 key 任一命中
  const canReview = can('app:approve-business-manager', 'edit') || can('app:approve-manager', 'edit');
  const [reviews, setReviews] = useState<Txn[]>([]);
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const [executionError, setExecutionError] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [deviceError, setDeviceError] = useState(false);
  const load = () => {
    pendingPages<Txn>('/business/execution/pending').then(rows => { setTxns(rows); setExecutionError(false); }).catch(() => setExecutionError(true));
    request<Txn[]>({ url: '/business/reviews' }).then(rows => { setReviews(rows); setReviewError(false); }).catch(() => setReviewError(true));
    request<{ mode: Mode }>({ url: '/business/execution/mode' }).then((r) => setMode(r.mode)).catch(() => setMode(null));
    accessCardIssuance.readiness().then(result => { setReady(result); setDeviceError(false); }).catch(() => setDeviceError(true));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => {
    const l = txns ?? [];
    return {
      needHand: l.filter((t) => t.externalSyncStatus === 'manual' || t.externalSyncStatus === 'failed' || t.externalSyncStatus === 'rejected'),
      review: [...new Map([...l.filter((t) => t.externalSyncStatus === 'review'), ...reviews].map((t) => [t.id, t])).values()],
      inFlight: l.filter((t) => ['queued', 'running', 'retry'].includes(t.externalSyncStatus)),
      dry: l.filter((t) => t.externalSyncStatus === 'dry_run'),
      // Same paid intake may still have an awaiting_docs transaction after upload.
      // Only deduplicate against a successfully refreshed submitted-intake list.
      docs: l.filter((t) => t.externalSyncStatus === 'awaiting_docs' && (intakeError || !canViewIntakes || ![...(intakes ?? []), ...awaitingSubmission].some(i => i.id === t.snapshot?.intake?.id))),
    };
  }, [txns, reviews, intakes, awaitingSubmission, intakeError, canViewIntakes]);
  const badAgents = useMemo(() => (ready?.agents ?? []).filter((a) => a.status !== 'online'), [ready]);
  const deliyunDown = ready?.deliyun && ready.deliyun.configured && !ready.deliyun.connected;

  const decide = async (t: Txn, approve: boolean, reason?: string) => {
    setBusy(t.id);
    try {
      await request({ method: 'POST', url: `/business/transactions/${t.id}/${approve ? 'approve' : 'reject'}`, data: { reason } });
      toast(approve ? '已通过，系统开始续期' : '已驳回，已通知收款人'); setRejecting(null); setTimeout(load, 800);
    } catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(null); }
  };

  const retry = async (t: Txn) => {
    setBusy(t.id);
    try { await request({ method: 'POST', url: `/business/transactions/${t.id}/retry-sync` }); toast('已重新排队'); setTimeout(load, 1500); }
    catch (e) { toast(e instanceof Error ? e.message : '重试失败'); }
    finally { setBusy(null); }
  };

  // 自动执行转人工的单：在停车系统里人工办好后登记，留审计
  const [doneFor, setDoneFor] = useState<{ id: number; note: string } | null>(null);
  const markDone = async (t: Txn, note: string) => {
    setBusy(t.id);
    try { await request({ method: 'POST', url: `/business/transactions/${t.id}/manual-done`, data: { note } }); toast('已登记为人工办好'); setDoneFor(null); setTimeout(load, 800); }
    catch (e) { toast(e instanceof Error ? e.message : '登记失败'); }
    finally { setBusy(null); }
  };

  if (txns === null && ready === null && !executionError && !deviceError) return <Loading />;

  const familyGroup = (status: string) => canViewFamily ? familyGroups.find(group => group.status === status) : undefined;
  const managerCount = groups.review.length + (familyGroup('manager')?.total ?? 0);
  const familyRows = (status: string) => {
    const group = familyGroup(status);
    if (!group?.total) return null;
    return <>
      {group.rows.map(item => <div className="pendRow" key={item.id}>
        <div className="pi ic amber"><Icon name="car" /></div>
        <div className="pm"><b>亲情车 {item.plate} <span className="tag warn">{group.label}</span></b>
          <small>{item.roomKey} · 申请 #{item.id}{item.lastError ? ` · ${item.lastError}` : ''}</small>
          <div className="pending-next">下一步 · {nextStep[status]}</div>
          <RecentAction entry={item.latestAction} /></div>
        <button className="btn sm" aria-label={`查看亲情车申请 ${item.plate}`} onClick={() => nav('/family-cars?detail=' + item.id + '&plate=' + encodeURIComponent(item.plate))}>查看申请</button>
      </div>)}
      {group.total > group.rows.length && <button className="btn sm" onClick={() => nav('/family-cars?status=' + status)}>查看全部 {group.total} 笔亲情车申请</button>}
    </>;
  };
  const stats = [
    { icon: 'file' as IconName, tone: 'amber', v: awaitingPayment.length, section: 'payment', k: '待收款' },
    ...(familyGroup('returned')?.total ? [{icon: 'file' as IconName, tone: 'amber', v: familyGroup('returned')!.total, section: 'returned', k: '待补正'}] : []),
    ...(canViewIntakes ? [{ icon: 'file' as IconName, tone: 'amber', v: intakeError ? '—' : intakes === null ? '…' : intakes.length + (familyGroup('office')?.rows.length ?? 0), section: 'office', k: '当前显示待审车牌' }] : []),
    { icon: 'clock' as IconName, tone: 'amber', v: canViewFamily && (familyError || !familyLoaded) ? '—' : managerCount, section: 'manager', k: '待经理审核' },
    { icon: 'file' as IconName, tone: 'amber', v: groups.docs.length + awaitingSubmission.length + (familyGroup('upload')?.total ?? 0), section: 'docs', k: '待提交资料' },
    { icon: 'alert' as IconName, tone: 'red', v: groups.needHand.length + (familyGroup('blocked')?.total ?? 0), section: 'manual', k: '需人工处理' },
    { icon: 'refresh' as IconName, tone: 'blue', v: groups.inFlight.length + (familyGroup('opening')?.total ?? 0), section: 'running', k: '执行中 / 排队' },
    { icon: 'check' as IconName, tone: 'amber', v: groups.dry.length, section: 'dry', k: '演练待正式写入' },
    { icon: 'cpu' as IconName, tone: 'red', v: badAgents.length + (deliyunDown ? 1 : 0), section: 'devices', k: '设备 / 助手异常' },
  ];
  const hasAny = executionError || reviewError || deviceError || txns === null || ready === null || (canViewFamily && (!familyLoaded || familyError || familyGroups.some(group => group.total))) || (canViewIntakes && (intakeLoading || intakeError || intakes?.length || awaitingPayment.length || awaitingSubmission.length)) || groups.review.length || groups.docs.length || groups.needHand.length || groups.inFlight.length || groups.dry.length || badAgents.length || deliyunDown;

  const row = (t: Txn) => {
    const s = ST[t.externalSyncStatus] || ST.queued;
    const ex = t.snapshot?.execution;
    const plate = t.snapshot?.vehicle?.plateNo || '';
    const canRetry = ['manual', 'failed', 'dry_run', 'retry'].includes(t.externalSyncStatus);
    let why = '';
    const rv = t.snapshot?.review;
    if (t.externalSyncStatus === 'awaiting_docs') why = '新办车牌：款已收，等业主扫码填车牌、上传资料，办公室审核通过后自动办理';
    else if (t.externalSyncStatus === 'review' && rv) why = `非标准续期 ${rv.startDate}~${rv.endDate} · 实收 ${money((rv.manualAmountCents ?? t.amountCents) / 100)}（按标准 ${money((rv.standardAmountCents ?? 0) / 100)}）· 原因：${rv.reason || '—'}`;
    else if (t.externalSyncStatus === 'rejected') why = `驳回原因：${rv?.decisionReason || '—'}。款已收、未续期，请按原因退款或重新办理`;
    else if (t.externalSyncStatus === 'dry_run' && ex?.result?.action === 'add_vehicle') why = `演练：将在 ${(ex.result.systems || []).join('、') || '所选车库'} 新增车牌，有效期至 ${ex.result.endDate || t.endDate}`;
    else if (t.externalSyncStatus === 'dry_run' && ex?.planned) why = `将把德立云到期日 ${ex.planned.previousEndDate} → ${ex.planned.endDate}`;
    else if (ex?.lastError) why = ex.lastError;
    else if (t.externalSyncStatus === 'retry' && ex?.nextAt) why = `第 ${ex.attempts} 次未成功，${formatBeijingDateTime(ex.nextAt, 'HH:mm')} 自动再试`;
    else if (t.externalSyncStatus === 'queued' || t.externalSyncStatus === 'running') why = '正在写入停车库（本次勾选的车库系统），完成后自动回读核对到期日';
    return (
      <div key={t.id} className="pendRow">
        <div className={`pi ic ${s.tone}`}><Icon name="car" /></div>
        <div className="pm">
          <b>{t.snapshot?.intake ? '新办车牌' : '停车续期'} {plate} <span className={`tag ${s.tag}`}>{s.t}</span></b>
          <div className="pending-next">下一步 · {nextStep[t.externalSyncStatus]}</div>
          <small>{t.txnNo} · 续至 {t.endDate || '—'} · 收款 {formatBeijingDateTime(t.createdAt, 'MM-DD HH:mm')}{why ? <> · <span className="why">{why}</span></> : null}</small>
          <RecentAction entry={ex?.finishedAt ? { at: ex.finishedAt, action: ex.lastError || s.t } : { at: t.createdAt, action: '登记收款' }} />
        </div>
        {t.externalSyncStatus === 'review' && canReview ? (
          rejecting?.id === t.id ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="in" style={{ height: 36, width: 220 }} autoFocus placeholder="驳回原因（必填）" value={rejecting.reason} onChange={(e) => setRejecting({ id: t.id, reason: e.target.value })} />
              <button className="btn sm d" disabled={busy === t.id || !rejecting.reason.trim()} onClick={() => void decide(t, false, rejecting.reason.trim())}>确认驳回</button>
              <button className="btn sm" onClick={() => setRejecting(null)}>取消</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm p" disabled={busy === t.id} onClick={() => void decide(t, true)}><Icon name="check" size={16} />通过</button>
              <button className="btn sm" disabled={busy === t.id} onClick={() => setRejecting({ id: t.id, reason: '' })}>驳回</button>
            </div>
          )
        ) : null}
        {canRetry ? <button className="btn sm" disabled={busy === t.id} onClick={() => retry(t)}><Icon name="refresh" size={16} />{t.externalSyncStatus === 'dry_run' ? '重新执行' : '重试'}</button> : null}
        {['manual', 'failed'].includes(t.externalSyncStatus) ? (doneFor?.id === t.id ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="in" style={{ height: 36, width: 240 }} autoFocus placeholder="在哪个系统怎么办好的（记入日志）" value={doneFor.note} onChange={(e) => setDoneFor({ id: t.id, note: e.target.value })} />
            <button className="btn sm p" disabled={busy === t.id || !doneFor.note.trim()} onClick={() => void markDone(t, doneFor.note.trim())}>确认</button>
            <button className="btn sm" onClick={() => setDoneFor(null)}>取消</button>
          </div>
        ) : <button className="btn sm" disabled={busy === t.id} onClick={() => setDoneFor({ id: t.id, note: '' })}><Icon name="check" size={16} />已人工办好</button>) : null}
      </div>
    );
  };

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>待处理</h1><p>查看未完成事项、当前进度及下一步操作</p></div>
      </div>

      <nav aria-label="按待办状态定位" className="pending-shortcuts">
        {stats.filter(s => s.v !== 0).map((s) => (
          <a key={s.k} className={`stat pending-shortcut ${s.tone}`} href={`#pending-${s.section}`}>
            <Icon name={s.icon} size={16} /><span className="k">{s.k}</span><b className="v">{s.v}</b>
          </a>
        ))}
      </nav>

      {(executionError || reviewError || deviceError) && <p role="alert">部分待办读取失败：{[executionError && '收款执行', reviewError && '经理审核', deviceError && '设备状态'].filter(Boolean).join('、')}。<button className="btn sm" onClick={load}>重新读取</button></p>}
      {canViewFamily && familyError && <p role="alert">{familyError} <button className="btn sm" onClick={() => setIntakeRefresh(n => n + 1)}>重试</button></p>}
      {canViewFamily && !familyLoaded && !familyError && <Loading />}
      {groups.needHand.length || familyGroup('blocked')?.total ? <><div id="pending-manual" className="secTitle"><Icon name="alert" size={18} style={{ color: 'var(--dang)' }} />需人工处理</div>{groups.needHand.map(row)}{familyRows('blocked')}</> : null}
      {awaitingPayment.length > 0 && <section id="pending-payment" aria-label="待收款"><h2 className="secTitle">待收款</h2>
        {awaitingPayment.map(i => <div className="pendRow" key={i.id}>
          <div className="pm"><b>{i.plate} <span className="tag warn">资料已通过 · 待收款</span></b>
            <div className="pending-next">下一步 · 核对金额，在原登记收款</div>
            <small>{i.houseLabel} · 登记 #{i.id}</small><RecentAction entry={i.log?.slice(-1)[0]} /></div>
          <button className="btn sm" onClick={() => nav('/cashier?intakeId=' + i.id)}>查看原登记</button>
        </div>)}</section>}
      {familyGroup('returned')?.total ? <section id="pending-returned" aria-label="待补正"><h2 className="secTitle">待补正</h2>{familyRows('returned')}</section> : null}
      {(canViewIntakes || groups.docs.length > 0 || !!familyGroup('upload')?.total) && <section id="pending-docs" aria-label="待提交资料" style={{ marginBottom: 18 }}>
        <h2 className="secTitle"><Icon name="file" size={18}/>待提交资料</h2>
        {familyRows('upload')}{groups.docs.map(row)}
        {awaitingSubmission.map(i => <div className="pendRow" key={i.id} style={{padding:12,marginBottom:8}}>
          <div className="pm"><b>{registrationTitle(i.kind)} #{i.id}</b> · {i.houseLabel} {i.plate}
          <div className="pending-next">下一步 · {i.status === 'reupload' ? '按退回原因补正并重新提交' : '填写并提交登记资料'}</div>
          <RecentAction entry={i.log?.slice(-1)[0] ?? { at: i.createdAt, action: '创建登记' }} /></div>
          <div>{i.status === 'reupload' ? '待补交资料' : '待提交资料'}{!i.qrValid ? ' · 二维码已过期，可在原单重新生成' : ''}
            <button className="btn sm" style={{marginLeft:12}} onClick={()=>nav('/plates?intakeId=' + i.id)}>{canReviewIntakes ? '继续办理' : '查看申请'}</button>
          </div>
        </div>)}
        {!groups.docs.length && !familyGroup('upload')?.total && !awaitingSubmission.length && <div className="muted">{intakeError ? '待提交资料读取失败，请刷新重试' : intakeLoading ? '正在读取待提交资料…' : '暂无待提交资料'}</div>}
      </section>}
      {canViewIntakes || familyGroup('office')?.total ? (
        <section id="pending-office" aria-label="新办车牌待审核资料" style={{ marginBottom: 18 }}>
          <div className="secTitle" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <Icon name="file" size={18} style={{ color: 'var(--warn)' }} />新办车牌待审核资料
            <button className="btn sm" aria-label="刷新待审核车牌" disabled={intakeLoading} onClick={() => setIntakeRefresh(n => n + 1)}><Icon name="refresh" size={16} />刷新</button>
            <button className="btn sm" onClick={() => nav('/plates')}>全部登记</button>
          </div>
          <p className="muted">业主已提交的付费新车及亲情车资料，不限是否收款；每 15 秒刷新。资料通过不代表停车授权已生效。</p>
          {intakeLoading && intakes === null ? <div role="status" className="muted">正在读取待审核车牌…</div> : null}
          {intakeError ? <div className="note2" role="alert" style={{ color: 'var(--dang)' }}>{intakeError}。请刷新重试；{intakes === null ? '尚不能确认待审数量。' : '下方保留上次读取结果，进入登记后以最新状态为准。'}</div> : null}
          {familyRows('office')}
          {(intakes ?? []).map(i => (
            <div className="pendRow" key={`intake-${i.id}`} style={{ flexWrap: 'wrap' }}>
              <div className="pi ic amber"><Icon name="car" /></div>
              <div className="pm" style={{ flex: '1 1 220px', minWidth: 0, overflowWrap: 'anywhere' }}>
                <b style={{ flexWrap: 'wrap' }}>{i.plate || '未填车牌'} <span className="tag warn">待审核资料</span></b>
                <div className="pending-next">下一步 · 核对申请资料，审核通过或退回补正</div>
                <RecentAction entry={i.log?.slice(-1)[0]} />
                <small>{i.kind === 'family' ? '亲情车' : '付费新车'} · 登记 #{i.id} · {i.houseLabel} · {i.contactName || i.ownerName || '未填车主'} · 提交 {formatBeijingDateTime(i.submittedAt || i.createdAt, 'MM-DD HH:mm')}{i.kind === 'paid' ? i.transaction ? ' · 已收款' : ' · 未收款' : ''}</small>
              </div>
              <button className="btn sm p" style={{ marginLeft: 'auto' }} aria-label={`${canReviewIntakes ? '查看并审核' : '查看'}登记 #${i.id}`} onClick={() => nav(`/plates?intakeId=${i.id}`)}>{canReviewIntakes ? '查看并审核' : '查看资料'}<Icon name="search" size={16} /></button>
            </div>
          ))}
          {!intakeLoading && !intakeError && intakes?.length === 0 && !familyGroup('office')?.total ? <p className="muted">暂无待审核的车牌资料</p> : null}
        </section>
      ) : null}

      {!hasAny ? (
        <div className="card" style={{ padding: '56px 20px', textAlign: 'center' }}>
          <Icon name="check" size={44} style={{ color: 'var(--ok)', marginBottom: 12 }} />
          <div className="muted" style={{ fontSize: 15 }}>没有待处理事项：收款后的同步都已完成，现场助手在线</div>
        </div>
      ) : null}

      {managerCount ? <section id="pending-manager" aria-label="待经理审核"><div className="secTitle"><Icon name="clock" size={18} style={{ color: 'var(--warn)' }} />待经理审核</div>{groups.review.map(row)}{familyRows('manager')}</section> : null}


      {groups.inFlight.length || familyGroup('opening')?.total ? <><div id="pending-running" className="secTitle"><Icon name="refresh" size={18} style={{ color: 'var(--acc)' }} />执行中</div>{groups.inFlight.map(row)}{familyRows('opening')}</> : null}
      {groups.dry.length ? <><div id="pending-dry" className="secTitle"><Icon name="check" size={18} style={{ color: 'var(--warn)' }} />演练记录（未写入德立云）</div>{groups.dry.map(row)}</> : null}

      {badAgents.length || deliyunDown ? (
        <>
          <div id="pending-devices" className="secTitle"><Icon name="cpu" size={18} style={{ color: 'var(--dang)' }} />设备与现场助手</div>
          {badAgents.map((a) => (
            <div key={a.id} className="pendRow">
              <div className="pi ic red"><Icon name="cpu" /></div>
              <div className="pm"><b>{a.name} <span className="tag dang">{a.status === 'offline' ? '离线' : '降级'}</span></b>
                <div className="pending-next">下一步 · 检查现场助手服务和网络，确认心跳恢复</div><small>{a.kind} · 版本 {a.version} · 最后心跳 {a.lastSeenAt ? dayjs(a.lastSeenAt).fromNow() : '未知'}</small>
              </div>
              <button className="btn sm" onClick={() => nav('/devices')}><Icon name="cpu" size={16} />查看设备</button>
            </div>
          ))}
          {deliyunDown ? (
            <div className="pendRow">
              <div className="pi ic red"><Icon name="car" /></div>
              <div className="pm"><b>德立云停车 <span className="tag dang">未连接</span></b><div className="pending-next">下一步 · 核对停车云连接，恢复后查看执行回执</div><small className="why">{ready?.deliyun?.message || '云端停车接口断连，续期暂不能执行，恢复后自动重试'}</small></div>
              <button className="btn sm" onClick={() => nav('/devices')}><Icon name="cpu" size={16} />查看</button>
            </div>
          ) : null}
        </>
      ) : null}

      {mode ? (
        <div className="note2" style={{ marginBottom: 14, ...(mode === 'on' ? {} : { color: 'var(--warn)' }) }}>
          <Icon name={mode === 'on' ? 'check' : 'alert'} />德立云自动同步 · {MODE[mode]}
        </div>
      ) : null}


    </>
  );
}
