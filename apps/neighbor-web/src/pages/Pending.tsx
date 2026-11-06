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
  const nav = useNavigate();
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [ready, setReady] = useState<AccessCardReadiness | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  // 收费类经理审核：新 key 或拆分前的旧 key 任一命中
  const canReview = can('app:approve-business-manager', 'edit') || can('app:approve-manager', 'edit');
  const [reviews, setReviews] = useState<Txn[]>([]);
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const load = () => {
    request<Txn[]>({ url: '/business/execution/pending' }).then(setTxns).catch(() => setTxns([]));
    request<Txn[]>({ url: '/business/reviews' }).then(setReviews).catch(() => setReviews([]));
    request<{ mode: Mode }>({ url: '/business/execution/mode' }).then((r) => setMode(r.mode)).catch(() => setMode(null));
  };
  useEffect(() => {
    load();
    accessCardIssuance.readiness().then(setReady).catch(() => setReady(null));
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
      docs: l.filter((t) => t.externalSyncStatus === 'awaiting_docs'),
    };
  }, [txns, reviews]);
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

  if (txns === null && ready === null) return <Loading />;

  const stats = [
    { icon: 'clock' as IconName, tone: 'amber', v: groups.review.length, k: '待经理审核' },
    { icon: 'file' as IconName, tone: 'amber', v: groups.docs.length, k: '新办等业主资料' },
    { icon: 'alert' as IconName, tone: 'red', v: groups.needHand.length, k: '需人工处理' },
    { icon: 'refresh' as IconName, tone: 'blue', v: groups.inFlight.length, k: '执行中 / 排队' },
    { icon: 'check' as IconName, tone: 'amber', v: groups.dry.length, k: '演练待正式写入' },
    { icon: 'cpu' as IconName, tone: 'red', v: badAgents.length + (deliyunDown ? 1 : 0), k: '设备 / 助手异常' },
  ];
  const hasAny = groups.review.length || groups.docs.length || groups.needHand.length || groups.inFlight.length || groups.dry.length || badAgents.length || deliyunDown;

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
    else if (t.externalSyncStatus === 'retry' && ex?.nextAt) why = `第 ${ex.attempts} 次未成功，${dayjs(ex.nextAt).format('HH:mm')} 自动再试`;
    else if (t.externalSyncStatus === 'queued' || t.externalSyncStatus === 'running') why = '正在写入停车库（本次勾选的车库系统），完成后自动回读核对到期日';
    return (
      <div key={t.id} className="pendRow">
        <div className={`pi ic ${s.tone}`}><Icon name="car" /></div>
        <div className="pm">
          <b>{t.snapshot?.intake ? '新办车牌' : '停车续期'} {plate} <span className={`tag ${s.tag}`}>{s.t}</span></b>
          <small>{t.txnNo} · 续至 {t.endDate || '—'} · 收款 {dayjs(t.createdAt).format('MM-DD HH:mm')}{why ? <> · <span className="why">{why}</span></> : null}</small>
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
        <div><h1 style={{ fontSize: 22 }}>待处理</h1><p>收款后的自动执行进展与需要人工处理的事项</p></div>
      </div>

      {mode ? (
        <div className="note2" style={{ marginBottom: 14, ...(mode === 'on' ? {} : { color: 'var(--warn)' }) }}>
          <Icon name={mode === 'on' ? 'check' : 'alert'} />德立云自动同步 · {MODE[mode]}
        </div>
      ) : null}

      <div className="pendGrid">
        {stats.map((s) => (
          <div key={s.k} className="stat"><div className={`ic ${s.tone}`} style={{ width: 44, height: 44 }}><Icon name={s.icon} /></div><div className="v">{s.v}</div><div className="k">{s.k}</div></div>
        ))}
      </div>

      {!hasAny ? (
        <div className="card" style={{ padding: '56px 20px', textAlign: 'center' }}>
          <Icon name="check" size={44} style={{ color: 'var(--ok)', marginBottom: 12 }} />
          <div className="muted" style={{ fontSize: 15 }}>没有待处理事项：收款后的同步都已完成，现场助手在线</div>
        </div>
      ) : null}

      {groups.review.length ? <><div className="secTitle"><Icon name="clock" size={18} style={{ color: 'var(--warn)' }} />待物业经理审核（非标准续期，通过后系统自动续期）</div>{groups.review.map(row)}</> : null}
      {groups.docs.length ? <><div className="secTitle"><Icon name="file" size={18} style={{ color: 'var(--warn)' }} />新办车牌：款已收，等业主资料（在「车牌登记审核」查看扫码进度）</div>{groups.docs.map(row)}</> : null}
      {groups.needHand.length ? <><div className="secTitle"><Icon name="alert" size={18} style={{ color: 'var(--dang)' }} />需人工处理</div>{groups.needHand.map(row)}</> : null}
      {groups.inFlight.length ? <><div className="secTitle"><Icon name="refresh" size={18} style={{ color: 'var(--acc)' }} />执行中</div>{groups.inFlight.map(row)}</> : null}
      {groups.dry.length ? <><div className="secTitle"><Icon name="check" size={18} style={{ color: 'var(--warn)' }} />演练记录（未写入德立云）</div>{groups.dry.map(row)}</> : null}

      {badAgents.length || deliyunDown ? (
        <>
          <div className="secTitle"><Icon name="cpu" size={18} style={{ color: 'var(--dang)' }} />设备与现场助手</div>
          {badAgents.map((a) => (
            <div key={a.id} className="pendRow">
              <div className="pi ic red"><Icon name="cpu" /></div>
              <div className="pm"><b>{a.name} <span className="tag dang">{a.status === 'offline' ? '离线' : '降级'}</span></b>
                <small>{a.kind} · 版本 {a.version} · 最后心跳 {a.lastSeenAt ? dayjs(a.lastSeenAt).fromNow() : '未知'}</small>
              </div>
              <button className="btn sm" onClick={() => nav('/devices')}><Icon name="cpu" size={16} />查看设备</button>
            </div>
          ))}
          {deliyunDown ? (
            <div className="pendRow">
              <div className="pi ic red"><Icon name="car" /></div>
              <div className="pm"><b>德立云停车 <span className="tag dang">未连接</span></b><small className="why">{ready?.deliyun?.message || '云端停车接口断连，续期暂不能执行，恢复后自动重试'}</small></div>
              <button className="btn sm" onClick={() => nav('/devices')}><Icon name="cpu" size={16} />查看</button>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="note2" style={{ marginTop: 18 }}><Icon name="alert" />重试是安全的：执行前先读德立云当前到期日，已是目标就直接算成功，不会续两次；到期日比本次更晚、车牌未登记、车位池车辆等对不上的情况一律转人工，不自动覆盖。门禁写卡接入执行层在下一阶段。</div>
    </>
  );
}
