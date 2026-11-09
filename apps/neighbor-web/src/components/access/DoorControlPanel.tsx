import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import { dayjs } from '@/lib/format';

// ───────────────────────── 门禁设备（立即开门 / 常开） ─────────────────────────
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
interface DoorControllers {
  agentOnline: boolean;
  gatewayVersion: string | null;
  checkedAt: string;
  controllers: DoorController[];
  /** 后端说明（例如所选小区不在二期联网门禁范围），只作说明，不阻断助手状态判断。 */
  message?: string | null;
}
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

/** 门禁设备管理：控制器在线状态、重新检查、立即开门 / 常开。从门禁发卡页拆出。 */
export default function DoorControlPanel({ communities, loaded, loadError, onReloadScope, canEdit }: {
  communities: Array<{ id: number; name: string }>;
  /** readiness 是否已返回：未返回前不显示「没有二期小区」。 */
  loaded: boolean;
  /** readiness 读取失败的原因；失败时不能再谎报「没有二期小区」或「助手离线」。 */
  loadError: string;
  /** 重新读取 readiness（门禁范围），不是重新读控制器。 */
  onReloadScope?: () => void;
  canEdit: boolean;
}) {
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
  const checkSeq = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setCommunityId((prev) => (prev != null && communities.some((c) => c.id === prev) ? prev : communities[0]?.id ?? null));
  }, [communities]);

  useEffect(() => {
    try {
      if (localStorage.getItem('accessDoor.collapsed') === '1') setCollapsed(true);
    } catch { /* 隐私模式不可用时保持默认展开 */ }
  }, []);

  // 小区切换/卸载时中止正在进行的在线检查轮询
  useEffect(() => () => { checkSeq.current += 1; }, [communityId]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('accessDoor.collapsed', next ? '1' : '0'); } catch { /* 忽略 */ }
      return next;
    });
  };

  useEffect(() => {
    // 没有二期联网门禁小区时不要伪造 agentOnline:false，否则又变成误报「助手离线」。
    if (!loaded) return undefined;
    if (communityId == null) { setData(null); setError(''); return undefined; }
    let alive = true;
    setData(null); setError('');
    request<DoorControllers>({ url: '/access-card-issuance/door/controllers', query: { communityId } })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData(null); setError(e instanceof Error ? e.message : '控制器列表读取失败'); } });
    return () => { alive = false; };
  }, [communityId, reload, loaded]);

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
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  /** 下发在线检查后每 2s 拉一次控制器列表，最多 15 次。 */
  const checkOnline = async () => {
    if (checking || communityId == null || !data?.agentOnline) return;
    const run = ++checkSeq.current;
    setChecking(true);
    try {
      const res = await request<{ controllerCount?: number; count?: number; controllers?: unknown[] }>({
        method: 'POST', url: '/access-card-issuance/door/check-online', data: { communityId },
      });
      const count = Number(res?.controllerCount ?? res?.count ?? (Array.isArray(res?.controllers) ? res.controllers.length : controllers.length)) || controllers.length;
      toast('已下发检查，' + count + ' 个控制器');
    } catch (e) {
      if (checkSeq.current === run) {
        setChecking(false);
        toast(e instanceof Error ? e.message : '下发检查失败，请稍后重试');
      }
      return;
    }
    let latest = controllers;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(2000);
      if (checkSeq.current !== run) return;
      try {
        const next = await request<DoorControllers>({ url: '/access-card-issuance/door/controllers', query: { communityId } });
        if (checkSeq.current !== run) return;
        latest = next.controllers;
        setData(next);
        setError('');
      } catch { /* 单次失败继续下一轮 */ }
    }
    if (checkSeq.current !== run) return;
    setChecking(false);
    toast('已更新 ' + latest.length + ' 个控制器状态');
  };
  const taskMeta = task ? DOOR_TASK[task.status] : null;

  return (
    <div className="card door-panel">
      <div className="panelHd door-head">
        <div className="door-title">
          <button type="button" className={`door-collapse${collapsed ? ' is-collapsed' : ''}`} aria-expanded={!collapsed} aria-label={collapsed ? '展开门禁设备' : '折叠门禁设备'} title={collapsed ? '展开' : '折叠'} onClick={toggleCollapsed}>
            <span className="door-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          </button>
          <b><Icon name="lock" size={17} /> 门禁设备</b>
          {!collapsed ? <span className="muted door-sub">现场开门前置控制 · 立即开门 / 常开</span> : null}
        </div>
        <div className="door-head-actions">
          {data ? (
            <span className={`tag ${data.agentOnline ? 'ok' : 'dang'}`} title={gatewayHint || undefined}>
              <Icon name={data.agentOnline ? 'check' : 'alert'} />助手{data.agentOnline ? '在线' : '离线'}
            </span>
          ) : null}
          {!collapsed && data?.gatewayVersion ? <span className="tag mute">网关 {data.gatewayVersion}</span> : null}
          {!collapsed && data?.checkedAt ? <span className="muted" style={{ fontSize: 12.5 }}>检测 {fmtDoorTime(data.checkedAt)}</span> : null}
          {!collapsed && communities.length ? (
            <select className="in" style={{ width: 180 }} value={communityId ?? ''} onChange={(e) => setCommunityId(e.target.value ? Number(e.target.value) : null)} aria-label="门禁小区">
              {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : null}
          {communities.length ? (
            <button className="btn sm door-check" disabled={checking || !data?.agentOnline} title={!data?.agentOnline ? '门禁助手离线，无法检查' : '重新检查控制器在线状态'} onClick={() => void checkOnline()}>
              {checking ? <><Icon name="refresh" size={15} />检查中…</> : '重新检查在线状态'}
            </button>
          ) : null}
          {!collapsed ? <button className="btn sm" onClick={() => setReload((v) => v + 1)}><Icon name="refresh" size={15} />刷新</button> : null}
        </div>
      </div>

      {!collapsed ? (
      <div className="door-body">
      {!canEdit ? <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />当前账号只有「业务查看」权限，远程开门按钮不可用。</div> : null}
      {!loaded ? (
        loadError
          ? <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 10 }}><Icon name="alert" />门禁设备范围读取失败：{loadError}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => onReloadScope?.()}>重试</button></div>
          : <Loading text="读取门禁设备范围…" />
      ) : !communities.length ? (
        <div className="note2" style={{ marginTop: 10 }}><Icon name="alert" />当前范围内没有二期联网门禁小区，远程开门不可用。</div>
      ) : null}
      {loaded && communities.length && data?.message ? (
        <div className="note2" style={{ marginTop: 10 }}><Icon name="alert" />{data.message}</div>
      ) : null}
      {error ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 10 }}><Icon name="alert" />{error}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setReload((v) => v + 1)}>重试</button></div> : null}
      {data && !gatewayReady ? (
        <div className="note2 door-disabled" style={{ marginTop: 10 }}>
          <Icon name="alert" />{gatewayHint || '网关未就绪（需要助手在线且版本 ≥ ' + MIN_GATEWAY_VERSION + '），远程开门已禁用。'}
        </div>
      ) : null}

      {!loaded || !communities.length ? null : data === null && !error ? <Loading text="读取门禁控制器…" /> : data && controllers.length === 0 ? (
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
