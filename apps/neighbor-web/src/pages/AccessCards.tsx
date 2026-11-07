import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, address, request } from '@pms/api-client';
import type { AccessCardIssueBatch, AccessCardIssueItem } from '@pms/api-client/src/endpoints/access-card-issuance';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { accessStatusLabel, legacyStatusLabel, rawTitle } from '@/lib/access-card-status';
import '@/styles/access-door.css';
import ToneIcon from '@/components/ToneIcon';

interface CardRow { id: number; cardNo: string; houseId: number; status?: string }
interface HistRow {
  id: number; sequence: number; roomLabel: string; icCardNo: string | null; wgCardNo: string | null;
  issuedAt: string | null; accessStatus: string; legacySyncStatus: string;
}

const CARD_STATUS: Record<string, { text: string; tone: string }> = {
  pending: { text: '等放卡', tone: 'mute' },
  card_completed: { text: '已写卡', tone: 'ok' },
  card_failed: { text: '写卡失败', tone: 'dang' },
};
const cardStatusLabel = (v?: string | null) => CARD_STATUS[v || ''] ?? { text: v ? '处理中' : '—', tone: 'mute' };

/**
 * 门禁管理：按户发卡 + 查卡 + 发卡历史，全部在本页完成（不再跳旧发卡台）。
 * 发卡走 /access-card-issuance/batches：建批次 → 装读卡器的工作站逐张写卡 →
 * 下发楼栋控制器 / 写旧物业库；页面轮询批次进度，允许单张重试下发。
 */
export default function AccessCards() {
  const session = useSession();
  const canEdit = can('business', 'edit');
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [history, setHistory] = useState<HistRow[] | null>(null);
  const [err, setErr] = useState('');

  const [issuer, setIssuer] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState(1);
  const [batch, setBatch] = useState<AccessCardIssueBatch | null>(null);
  const [busy, setBusy] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  useEffect(() => {
    accessCardIssuance.readiness()
      .then((r) => {
        const list = (r?.agents ?? []) as Array<{ id: string; kind: string; name?: string; status: string }>;
        const iss = list.find((a) => a.kind === 'issuer' && a.status === 'online') ?? null;
        setIssuer(iss ? { id: iss.id, name: iss.name || '发卡工作站' } : null);
      })
      .catch(() => setIssuer(null));
  }, []);

  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const loadHouse = useCallback((houseId: number) => {
    setCards(null); setHistory(null); setErr('');
    request<{ accessCards: CardRow[] }>({ url: '/business/search', query: { q: '', serviceType: 'access_card' } })
      .then((r) => setCards((r?.accessCards ?? []).filter((c) => c.houseId === houseId)))
      .catch(() => setCards([]));
    accessCardIssuance.houseContext(houseId)
      .then((c) => setHistory((c?.history ?? []) as never))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!picked?.houseId) { setCards(null); setHistory(null); setBatch(null); return; }
    loadHouse(picked.houseId);
  }, [picked?.houseId, loadHouse]);

  useEffect(() => {
    if (!batch) return undefined;
    const done = batch.items.every((i) => i.cardStatus === 'card_completed' || i.cardStatus === 'card_failed');
    if (done) return undefined;
    timer.current = window.setTimeout(() => {
      accessCardIssuance.batch(batch.id).then(setBatch).catch(() => undefined);
    }, 3000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [batch]);

  const startBatch = async () => {
    if (!can('business', 'edit')) return;
    if (!picked?.houseId) { toast('先选一户'); return; }
    setBusy('create');
    try {
      const r = await accessCardIssuance.createBatch({
        houseId: picked.houseId,
        quantity: qty,
        extraBuildingIds: [],
        workstationId: issuer?.id,
        idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      });
      setBatch(r);
      toast('发卡任务已建立，请把第 1 张卡放到读卡器上');
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建发卡任务失败');
    } finally { setBusy(''); }
  };

  const retryAccess = async (item: AccessCardIssueItem) => {
    if (!can('business', 'edit')) return;
    if (!batch) return;
    setBusy(`retry-${item.id}`);
    try { setBatch(await accessCardIssuance.retryAccessUpload(batch.id, item.id)); toast('已重新下发'); }
    catch (e) { toast(e instanceof Error ? e.message : '重试失败'); }
    finally { setBusy(''); }
  };

  const cur = batch?.items.find((i) => i.cardStatus !== 'card_completed');

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="cards" /><h1 style={{ fontSize: 22 }}>门禁卡管理</h1></div>
          <p>按户发卡、查卡与发卡历史；写卡由装了读卡器的工作站自动完成</p>
        </div>
        <div className="act">
          <span className={`tag ${issuer ? 'ok' : 'warn'}`}><Icon name={issuer ? 'check' : 'alert'} />{issuer ? '发卡工作站在线' : '发卡工作站离线'}</span>
        </div>
      </div>

      <DoorControlPanel communities={communities} canEdit={canEdit} />

      <div className="findBar" style={{ marginBottom: 14 }}>
        <HousePicker communities={communities} value={picked}
          onPick={(p) => { setPicked(p); setBatch(null); }}
          onClear={() => { setPicked(null); setBatch(null); }}
          onIncomplete={() => toast('请再点一下具体室号：发卡要落到具体一户')} />
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{err}</div> : null}

      {!picked ? (
        <div className="card" style={{ padding: '56px 20px', textAlign: 'center' }}>
          <Icon name="key" size={42} style={{ color: 'var(--ink4)', marginBottom: 10 }} />
          <div className="muted" style={{ fontSize: 15 }}>选一户，发卡或查看这一户的门禁卡</div>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 12 }}>
              <b>发门禁卡</b>
              <span className="muted" style={{ marginLeft: 8 }}>{picked.communityName} {picked.buildingNo}/{picked.roomNo}</span>
            </div>
            {!batch ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => setQty((n) => Math.max(1, n - 1))}>−</button>
                <b style={{ fontSize: 20, minWidth: 28, textAlign: 'center' }}>{qty}</b>
                <button className="btn" onClick={() => setQty((n) => Math.min(20, n + 1))}>＋</button>
                <span className="muted">张</span>
                <button className="btn p" style={{ marginLeft: 'auto' }} disabled={!canEdit || busy === 'create'} onClick={() => void startBatch()}>
                  <Icon name="key" size={16} />{busy === 'create' ? '建立中…' : '开始发卡'}
                </button>
              </div>
            ) : (
              <>
                <div className="note" style={{ marginBottom: 10 }}>
                  任务 #{batch.id} · 共 {batch.quantity} 张{batch.currentSequence ? ` · 当前第 ${batch.currentSequence} 张` : ''}
                  {cur && cur.cardStatus !== 'card_completed' ? '：请把这张卡放到读卡器上' : ''}
                </div>
                <div className="t-scroll">
                  <table className="t" style={{ minWidth: 760 }}>
                    <thead><tr><th style={{ width: 60 }}>序号</th><th>卡号</th><th>写卡</th><th>门禁授权</th><th>旧库同步</th><th style={{ width: 96 }}>操作</th></tr></thead>
                    <tbody>
                      {batch.items.map((it) => {
                        const cs = cardStatusLabel(it.cardStatus);
                        const as = accessStatusLabel(it.accessStatus);
                        const ls = legacyStatusLabel(it.legacySyncStatus);
                        const canRetry = !!it.icCardNo && /^(waiting_retry|needs_operator|permission_check_failed|not_uploaded)$/.test(it.accessStatus || '');
                        return (
                          <tr key={it.id}>
                            <td className="nw muted">{it.sequence}</td>
                            <td className="nw"><b>{it.icCardNo || '—'}</b>{it.wgCardNo ? <span className="muted"> · WG {it.wgCardNo}</span> : null}</td>
                            <td className="nw"><span className={`tag ${cs.tone}`}>{cs.text}</span></td>
                            <td className="nw"><span className={`tag ${as.tone}`} title={rawTitle(it.accessStatus)}>{as.text}</span></td>
                            <td className="nw"><span className={`tag ${ls.tone}`} title={rawTitle(it.legacySyncStatus)}>{ls.text}</span></td>
                            <td className="nw">
                              {canEdit && canRetry ? <button className="btn g sm" disabled={busy === `retry-${it.id}`} onClick={() => void retryAccess(it)}><Icon name="refresh" size={15} />重试下发</button> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {batch.items.some((i) => i.lastErrorMessage) ? (
                  <div className="note2" style={{ marginTop: 8, color: 'var(--dang)' }}>{batch.items.filter((i) => i.lastErrorMessage).map((i) => `第 ${i.sequence} 张：${i.lastErrorMessage}`).join('；')}</div>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <button className="btn" onClick={() => { setBatch(null); if (picked) loadHouse(picked.houseId); }}>结束 / 看结果</button>
                </div>
              </>
            )}
            <div className="note2" style={{ marginTop: 10 }}>
              <Icon name="alert" />写卡要读卡器，由{issuer ? `在线工作站「${issuer.name}」` : '工作站'}自动完成；本页负责建任务、看进度、下发失败单张重试。
            </div>
          </div>

          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>在用门禁卡</b>
              <span className="tag mute" style={{ marginLeft: 8 }}>{cards?.length ?? 0} 张</span>
            </div>
            {cards === null ? <Loading text="读门禁卡…" /> : cards.length === 0 ? (
              <div className="muted">这一户还没有在用门禁卡</div>
            ) : cards.map((c) => (
              <div key={c.id} className="cardItem">
                <div className="ci"><Icon name="key" /></div>
                <div className="bt" style={{ flex: 1 }}><b>卡号 {c.cardNo}</b><small className="muted">{c.status === 'active' || !c.status ? '正常' : c.status}</small></div>
                <span className="tag ok"><Icon name="check" />有效</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>发卡历史</b>
              {history?.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{history.length} 张</span> : null}
            </div>
            {history === null ? <Loading text="读发卡记录…" /> : history.length === 0 ? (
              <div className="muted">这一户还没有发卡记录</div>
            ) : (
              <div className="t-scroll">
                <table className="t" style={{ minWidth: 720 }}>
                  <thead><tr><th style={{ width: 70 }}>序号</th><th>卡号</th><th>发卡时间</th><th>门禁授权</th><th>旧库同步</th></tr></thead>
                  <tbody>
                    {history.map((h) => {
                      const as = accessStatusLabel(h.accessStatus);
                      const ls = legacyStatusLabel(h.legacySyncStatus);
                      return (
                        <tr key={h.id}>
                          <td className="nw muted">{h.sequence}</td>
                          <td className="nw"><b>{h.icCardNo || h.wgCardNo || '—'}</b>{h.icCardNo && h.wgCardNo ? <span className="muted"> · WG {h.wgCardNo}</span> : null}</td>
                          <td className="nw">{h.issuedAt ? dayjs(h.issuedAt).format('YYYY-MM-DD HH:mm') : '—'}</td>
                          <td className="nw"><span className={`tag ${as.tone}`} title={rawTitle(h.accessStatus)}>{as.text}</span></td>
                          <td className="nw"><span className={`tag ${ls.tone}`} title={rawTitle(h.legacySyncStatus)}>{ls.text}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ───────────────────────── 远程门禁（立即开门 / 常开） ─────────────────────────
const MIN_GATEWAY_VERSION = '2.5.46';

type DoorOperation = 'remote_open' | 'temporary_open';
type DoorStatus = 'online' | 'offline' | 'pending' | 'unknown';
interface DoorController {
  communityId: number; communityName?: string | null;
  controllerId: number; buildingNo: string; doorNo: number | null; doorName: string;
  controllerName: string | null; accessSystem: string; routeReady?: boolean;
  status: DoorStatus; supportRemoteOpen: boolean; supportTemporaryOpen: boolean;
  lastOperation?: string | null; lastCheckedAt: string | null; lastError: string | null;
}
interface DoorControllers { agentOnline: boolean; gatewayVersion: string | null; checkedAt: string; controllers: DoorController[] }
interface DoorTask {
  taskId: number; operation: string; status: 'pending' | 'sent' | 'succeeded' | 'failed'; rawStatus?: string;
  controllerId?: number | null; doorNo?: number | null; buildingNo?: string | null;
  accessSystem?: string | null; minutes?: number | null; controller?: string | null; door?: string | null;
  protocol?: string | null; acknowledgement?: string | null; receipt?: Record<string, unknown> | null;
  error?: string | null; attempt?: number; requestedAt?: string; completedAt?: string | null;
}

const DOOR_STATUS: Record<DoorStatus, { text: string; tone: string }> = {
  online: { text: '在线', tone: 'ok' },
  offline: { text: '离线', tone: 'mute' },
  pending: { text: '未探测', tone: 'warn' },
  unknown: { text: '未探测', tone: 'warn' },
};
const DOOR_TASK: Record<DoorTask['status'], { text: string; tone: string; hint: string }> = {
  pending: { text: '已提交', tone: 'warn', hint: '已入队，等待网关领取' },
  sent: { text: '发送中', tone: 'blue', hint: '网关已领取，正在发往控制器' },
  succeeded: { text: '成功', tone: 'ok', hint: '控制器已回执确认' },
  failed: { text: '失败', tone: 'dang', hint: '控制器明确失败，请查看错误信息' },
};
const SYSTEM_LABEL: Record<string, string> = { iccard: 'IC 卡', mjsystem: 'MjSystem' };
const operationLabel = (op: DoorOperation) => (op === 'remote_open' ? '立即开门' : '常开');

/** 网关版本是否 ≥ 2.5.46；解析失败按不满足处理，避免误开。 */
function gatewayAtLeast(version: string | null, min: string) {
  if (!version) return false;
  const parse = (v: string) => (v.split(/[.+-]/).slice(0, 3).map((part) => Number(part)).map((n) => (Number.isFinite(n) ? n : 0)));
  const a = parse(version), b = parse(min);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
function newIdempotencyKey() {
  try { return crypto.randomUUID(); } catch { return 'door-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
}
const fmtDoorTime = (value: string | null | undefined) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—');

function DoorControlPanel({ communities, canEdit }: { communities: AddressCommunity[]; canEdit: boolean }) {
  const [communityId, setCommunityId] = useState<number | null>(communities[0]?.id ?? null);
  const [data, setData] = useState<DoorControllers | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<{ controller: DoorController; operation: DoorOperation } | null>(null);
  const [phase, setPhase] = useState<'form' | 'confirm' | 'task'>('form');
  const [minutes, setMinutes] = useState(5);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [task, setTask] = useState<DoorTask | null>(null);
  const [taskError, setTaskError] = useState('');
  const idemKey = useRef('');

  useEffect(() => {
    setCommunityId((prev) => (prev != null && communities.some((c) => c.id === prev) ? prev : communities[0]?.id ?? null));
  }, [communities]);

  useEffect(() => {
    if (communityId == null) { setData({ agentOnline: false, gatewayVersion: null, checkedAt: new Date().toISOString(), controllers: [] }); return undefined; }
    let alive = true;
    setData(null); setError('');
    request<DoorControllers>({ url: '/access-card-issuance/door/controllers', query: { communityId } })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData(null); setError(e instanceof Error ? e.message : '控制器列表读取失败'); } });
    return () => { alive = false; };
  }, [communityId, reload]);

  // 任务轮询：pending/sent 时每 1.2s 查一次，成功后停止。
  useEffect(() => {
    if (!task || (task.status !== 'pending' && task.status !== 'sent')) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      request<DoorTask>({ url: '/access-card-issuance/door/task/' + task.taskId })
        .then((next) => { if (alive) { setTaskError(''); setTask(next); } })
        .catch(() => { if (alive) setTaskError('任务状态读取失败，可点击“重新查询”继续。'); });
    }, 1200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [task]);

  const gatewayReady = !!data && data.agentOnline && gatewayAtLeast(data.gatewayVersion, MIN_GATEWAY_VERSION);
  const gatewayHint = !data
    ? ''
    : !data.agentOnline ? '门禁助手离线，远程开门已禁用。请检查助手运行状态后刷新。'
      : !gatewayAtLeast(data.gatewayVersion, MIN_GATEWAY_VERSION) ? `网关版本 ${data.gatewayVersion || '未知'} 低于 ${MIN_GATEWAY_VERSION}，远程开门已禁用，请升级助手。`
        : '';

  const openDialog = (controller: DoorController, operation: DoorOperation) => {
    if (!canEdit || !gatewayReady) return;
    setDialog({ controller, operation });
    setPhase('form');
    setMinutes(5);
    setReason('');
    setSubmitError('');
    setTask(null);
    setTaskError('');
    idemKey.current = '';
  };
  const closeDialog = () => {
    setDialog(null); setPhase('form'); setTask(null); setTaskError(''); setSubmitError(''); idemKey.current = '';
  };
  const submit = async () => {
    if (!dialog) return;
    if (!reason.trim()) { toast('请填写开门原因'); return; }
    if (dialog.operation === 'temporary_open' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)) { toast('常开分钟数需在 1–60 之间'); return; }
    setBusy(true); setSubmitError('');
    if (!idemKey.current) idemKey.current = newIdempotencyKey();
    try {
      const r = await request<DoorTask>({
        method: 'POST', url: '/access-card-issuance/door/open',
        data: {
          communityId: dialog.controller.communityId,
          controllerId: dialog.controller.controllerId,
          doorNo: dialog.controller.doorNo ?? undefined,
          operation: dialog.operation,
          minutes: dialog.operation === 'temporary_open' ? minutes : undefined,
          reason: reason.trim(),
          idempotencyKey: idemKey.current,
        },
      });
      setTask(r); setPhase('task');
    } catch (e) {
      // 超时/网络失败：保留 idempotencyKey，重试复用同一把钥匙，避免重复开门。
      setSubmitError(e instanceof Error ? e.message : '提交失败，请稍后重试');
    } finally { setBusy(false); }
  };
  const repoll = () => {
    if (!task) return;
    setTaskError('');
    request<DoorTask>({ url: '/access-card-issuance/door/task/' + task.taskId })
      .then((next) => setTask(next))
      .catch(() => setTaskError('任务状态读取失败，请稍后再试。'));
  };

  const controllers = data?.controllers ?? [];
  const taskMeta = task ? DOOR_TASK[task.status] : null;

  return (
    <div className="card door-panel">
      <div className="panelHd door-head">
        <div>
          <b><Icon name="lock" size={17} /> 远程门禁</b>
          <span className="muted" style={{ marginLeft: 8 }}>现场开门前置控制 · 立即开门 / 常开</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <select className="in" style={{ width: 180 }} value={communityId ?? ''} onChange={(e) => setCommunityId(e.target.value ? Number(e.target.value) : null)} aria-label="远程门禁小区">
            {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {data ? (
            <span className={`tag ${data.agentOnline ? 'ok' : 'dang'}`} title={gatewayHint || undefined}>
              <Icon name={data.agentOnline ? 'check' : 'alert'} />助手{data.agentOnline ? '在线' : '离线'}
            </span>
          ) : null}
          {data?.gatewayVersion ? <span className="tag mute">网关 {data.gatewayVersion}</span> : null}
          {data?.checkedAt ? <span className="muted" style={{ fontSize: 12.5 }}>检测 {fmtDoorTime(data.checkedAt)}</span> : null}
          <button className="btn sm" onClick={() => setReload((v) => v + 1)}><Icon name="refresh" size={15} />刷新</button>
        </div>
      </div>

      {!canEdit ? <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />当前账号只有「业务查看」权限，远程开门按钮不可用。</div> : null}
      {error ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 10 }}><Icon name="alert" />{error}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setReload((v) => v + 1)}>重试</button></div> : null}
      {data && !gatewayReady ? (
        <div className="note2 door-disabled" style={{ marginTop: 10 }}>
          <Icon name="alert" />{gatewayHint || '网关未就绪（需要助手在线且版本 ≥ ' + MIN_GATEWAY_VERSION + '），远程开门已禁用。'}
        </div>
      ) : null}

      {data === null && !error ? <Loading text="读取门禁控制器…" /> : data && controllers.length === 0 ? (
        <div className="muted" style={{ padding: '18px 4px' }}>当前小区没有可远程控制的门禁控制器（仅二期联网门禁支持）。</div>
      ) : data ? (
        <div className="t-scroll door-table">
          <table className="t" style={{ minWidth: 880 }}>
            <thead>
              <tr><th className="nw">楼栋</th><th className="nw">门名</th><th className="nw">系统</th><th className="nw">在线状态</th><th className="nw">最后检测</th><th className="nw" style={{ width: 210 }}>操作</th></tr>
            </thead>
            <tbody>
              {controllers.map((row) => {
                const st = DOOR_STATUS[row.status] || DOOR_STATUS.unknown;
                const disabled = !canEdit || !gatewayReady;
                return (
                  <tr key={row.controllerId}>
                    <td className="nw"><b>{row.buildingNo}</b>{row.doorNo != null ? <span className="muted"> 号楼 / 门{row.doorNo}</span> : null}</td>
                    <td className="nw">{row.doorName || '—'}{row.controllerName ? <small className="muted"> · {row.controllerName}</small> : null}</td>
                    <td className="nw"><span className="tag mute">{SYSTEM_LABEL[row.accessSystem] || row.accessSystem}</span></td>
                    <td className="nw"><span className={`tag ${st.tone}`}>{st.text}</span>{row.lastError ? <small className="door-row-err" title={row.lastError}>{row.lastError}</small> : null}</td>
                    <td className="nw">{fmtDoorTime(row.lastCheckedAt)}</td>
                    <td className="nw door-actions">
                      <button
                        className="btn sm"
                        disabled={disabled || !row.supportRemoteOpen}
                        title={!canEdit ? '需要业务编辑权限' : !gatewayReady ? '助手离线或网关版本过低' : '立即开门'}
                        onClick={() => openDialog(row, 'remote_open')}
                      ><Icon name="key" size={15} />立即开门</button>
                      <button
                        className="btn sm"
                        disabled={disabled || !row.supportTemporaryOpen}
                        title={!row.supportTemporaryOpen ? '该控制器仅支持立即开门' : !canEdit ? '需要业务编辑权限' : !gatewayReady ? '助手离线或网关版本过低' : '常开（1–60 分钟）'}
                        onClick={() => openDialog(row, 'temporary_open')}
                      ><Icon name="clock" size={15} />常开</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {dialog ? (
        <div className="door-mask" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div className="door-dialog" role="dialog" aria-modal="true" aria-label="远程开门确认">
            <div className="door-dialog-head">
              <b>{phase === 'task' ? '开门任务' : (phase === 'confirm' ? '确认远程开门' : operationLabel(dialog.operation))}</b>
              <button className="btn sm g" onClick={closeDialog}>关闭</button>
            </div>

            {phase !== 'task' ? (
              <>
                <div className="door-summary">
                  <div><span>楼栋</span><b>{dialog.controller.buildingNo} 号楼</b></div>
                  <div><span>门</span><b>{dialog.controller.doorName}{dialog.controller.doorNo != null ? `（门${dialog.controller.doorNo}）` : ''}</b></div>
                  <div><span>系统</span><b>{SYSTEM_LABEL[dialog.controller.accessSystem] || dialog.controller.accessSystem}</b></div>
                  <div><span>操作</span><b>{operationLabel(dialog.operation)}{dialog.operation === 'temporary_open' ? ` · ${minutes} 分钟` : ''}</b></div>
                </div>

                {phase === 'form' ? (
                  <>
                    {dialog.operation === 'temporary_open' ? (
                      <div className="door-form">
                        <label>常开分钟数（1–60，默认 5）
                          <div className="door-quick">
                            {[5, 10, 30].map((m) => <button key={m} type="button" className={`chip ${minutes === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>{m} 分钟</button>)}
                            <input className="in" style={{ width: 90 }} type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} aria-label="常开分钟数" />
                          </div>
                        </label>
                      </div>
                    ) : null}
                    <label className="door-form">开门原因（必填）
                      <textarea className="in" rows={3} value={reason} maxLength={200} placeholder="例如：业主忘带卡，已电话核实身份，门边有人" onChange={(e) => setReason(e.target.value)} aria-label="开门原因" />
                    </label>
                    {submitError ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{submitError}<button className="btn sm" style={{ marginLeft: 10 }} disabled={busy} onClick={() => void submit()}>重试（复用同一请求）</button></div> : null}
                    <div className="door-dialog-foot">
                      <button className="btn" onClick={closeDialog}>取消</button>
                      <button className="btn p" disabled={busy} onClick={() => {
                        if (!reason.trim()) { toast('请填写开门原因'); return; }
                        if (dialog.operation === 'temporary_open' && (minutes < 1 || minutes > 60)) { toast('常开分钟数需在 1–60 之间'); return; }
                        setPhase('confirm');
                      }}>下一步</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="door-warn" role="alert"><Icon name="alert" size={20} /><b>将现场开门，确认门边有人</b></div>
                    <div className="door-summary" style={{ marginTop: 10 }}>
                      <div><span>原因</span><b>{reason}</b></div>
                    </div>
                    {submitError ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{submitError}<button className="btn sm" style={{ marginLeft: 10 }} disabled={busy} onClick={() => void submit()}>重试（复用同一请求）</button></div> : null}
                    <div className="door-dialog-foot">
                      <button className="btn" disabled={busy} onClick={() => setPhase('form')}>返回修改</button>
                      <button className="btn p" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '确认开门'}</button>
                    </div>
                  </>
                )}
              </>
            ) : task && taskMeta ? (
              <>
                <div className="door-task-status">
                  <span className={`tag ${taskMeta.tone}`}>{taskMeta.text}</span>
                  <b>{taskMeta.hint}</b>
                  {task.attempt ? <span className="muted">第 {task.attempt} 次尝试</span> : null}
                </div>
                <div className="door-summary">
                  <div><span>任务</span><b>#{task.taskId}</b></div>
                  <div><span>楼栋/门</span><b>{task.buildingNo || dialog.controller.buildingNo} 号楼{task.door ? ` · ${task.door}` : ''}</b></div>
                  <div><span>操作</span><b>{operationLabel(dialog.operation)}{task.minutes ? ` · ${task.minutes} 分钟` : ''}</b></div>
                  <div><span>提交时间</span><b>{fmtDoorTime(task.requestedAt)}</b></div>
                  {task.completedAt ? <div><span>完成时间</span><b>{fmtDoorTime(task.completedAt)}</b></div> : null}
                  {task.controller ? <div><span>控制器</span><b>{task.controller}</b></div> : null}
                  {task.protocol ? <div><span>协议</span><b>{task.protocol}</b></div> : null}
                  {task.acknowledgement ? <div><span>回执</span><b>{task.acknowledgement}</b></div> : null}
                </div>
                {task.error ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{task.error}</div> : null}
                {taskError ? <div className="note2"><Icon name="alert" />{taskError}</div> : null}
                {task.status === 'pending' || task.status === 'sent' ? <div className="muted" style={{ marginTop: 8 }}><Icon name="refresh" size={14} /> 正在轮询任务状态…</div> : null}
                {task.receipt ? <pre className="door-receipt">{JSON.stringify(task.receipt, null, 2)}</pre> : null}
                <div className="door-dialog-foot">
                  {(task.status === 'pending' || task.status === 'sent') ? <button className="btn" onClick={repoll}>重新查询</button> : null}
                  <button className="btn p" onClick={closeDialog}>完成</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
