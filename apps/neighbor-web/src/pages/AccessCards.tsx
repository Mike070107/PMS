import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, address, request } from '@pms/api-client';
import type { AccessCardIssueBatch, AccessCardIssueItem, AccessCardReadiness } from '@pms/api-client/src/endpoints/access-card-issuance';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { accessStatusLabel, legacyStatusLabel, rawTitle } from '@/lib/access-card-status';
import '@/styles/access-door.css';
import ToneIcon from '@/components/ToneIcon';
interface CardRow { id: number; cardNo: string; houseId: number; status?: string }
interface CardHistoryRow {
  id: number; personNo?: string | null; sequence: number; roomLabel: string; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
  accessSystem?: 'iccard' | 'mjsystem' | null; homeBuildingNo?: string | null; communityId?: number | null;
}
interface CardHistoryResp { status: 'ready' | 'pending'; rows: CardHistoryRow[]; refreshedAt?: string; fieldsIncomplete?: boolean }
type CardRecent = {
  id: number; personNo?: string | null; sequence?: number; roomLabel: string; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
  accessSystem?: 'iccard' | 'mjsystem' | null; homeBuildingNo?: string | null;
  communityId?: number | null; communityName?: string | null; lane?: string | null; buildingId?: number | null;
  buildingNo?: string | null; buildingText?: string | null; houseId?: number | null; roomNo?: string | null;
  roomKey?: string | null; projectPhase?: 'phase1' | 'phase2' | null;
  ownerName?: string | null; ownerPhone?: string | null; ownerId?: number | null; fieldsIncomplete?: boolean;
};
/**
 * /access-card-issuance/cards/recent 返回的是刷新状态对象，不是数组：
 * 首次请求可能是 status='pending' + 上次的旧行，后台刷新完成才变 ready。
 */
interface CardRecentResp {
  status: 'ready' | 'pending' | 'error';
  rows: CardRecent[];
  error?: string | null;
  refreshedAt?: string | null;
  fieldsIncomplete?: boolean;
  refreshing?: boolean;
  permissionStatus?: string;
  permissions?: unknown[];
}
const RECENT_POLL_MS = 1500;
const RECENT_POLL_MAX = 5;

interface CapabilityTag { key: string; ok: boolean; text: string; title: string }
/**
 * 顶部门禁能力标签：按 readiness.features 分项显示，不再用一句「发卡工作站离线」概括整页。
 * 生产现场 readiness 里没有 issuer 类 agent（只有 access_gateway/legacy_sync/parking_gateway），
 * 写卡工作站是否接入要看 features.cardWrite，而不是找 agent.kind==='issuer'。
 */
function readinessCapabilityTags(readiness: AccessCardReadiness | null): CapabilityTag[] {
  const f = readiness?.features;
  if (!f) return [];
  const doorWritable = !!f.accessDbWrite && !!f.controllerUpload;
  const missing = [!f.accessDbWrite ? '.88 门禁库写入' : '', !f.controllerUpload ? '楼栋控制器下发' : ''].filter(Boolean).join('、');
  return [
    {
      key: 'cardWrite',
      ok: !!f.cardWrite,
      text: f.cardWrite ? '写卡工作站已接入' : '写卡工作站未接入',
      title: f.cardWrite
        ? '写卡工作站已接入，新卡可写到读卡器'
        : '当前没有写卡工作站接入，新卡暂不能写到读卡器；查发卡历史、写入 .88 门禁库、远程开门不受影响',
    },
    {
      key: 'legacyDbWrite',
      ok: !!f.legacyDbWrite,
      text: f.legacyDbWrite ? '.80 捷顺库在线' : '.80 捷顺库未接入',
      title: f.legacyDbWrite ? '.80 捷顺旧库读写能力在线' : '.80 捷顺旧库助手未接入，旧库同步与捷顺发卡历史不可用',
    },
    {
      key: 'accessDbWrite',
      ok: doorWritable,
      text: doorWritable ? '.88 门禁网关在线' : (f.accessDbWrite || f.controllerUpload ? '.88 门禁网关部分可用' : '.88 门禁网关未接入'),
      title: doorWritable ? '.88 门禁库写入与楼栋控制器下发能力均在线' : `缺少能力：${missing}`,
    },
  ];
}

/** 从 roomKey/roomLabel 反推弄/楼/室，兼容旧助手只回传 roomLabel 的记录。 */
function recentRoomParts(row: CardRecent) {
  const raw = String(row.roomKey || row.roomLabel || '').replace(/已隐藏/g, '').trim();
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return { lane: parts[0], buildingNo: parts[1], roomNo: parts[2] };
  if (parts.length === 2) return { lane: null, buildingNo: parts[0], roomNo: parts[1] };
  return { lane: null, buildingNo: null, roomNo: null };
}

interface CardDetail {
  id: number; appliedSystems?: string[]; grantedBuildings?: string[]; latestTasks?: unknown[];
  icCardNo?: string | null; wgCardNo?: string | null; roomLabel?: string | null; status?: string | null;
  communityId?: number | null; homeBuildingNo?: string | null; accessSystem?: 'iccard' | 'mjsystem' | null;
}

/** 发卡历史与最近 30 笔共用的行视图（11 列表格）；displayNo 为页面上显示的序号。 */
interface CardRecordView {
  id: number; personNo?: string | null; roomLabel: string; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
  accessSystem?: 'iccard' | 'mjsystem' | null; homeBuildingNo?: string | null; communityId?: number | null;
  displayNo: number;
}
/** 授权楼栋可选项：来自 grant-options（优先）或门禁控制器列表。 */
interface GrantOption { buildingNo: string; doorName?: string | null; accessSystem?: string | null }

const HISTORY_PAGE_SIZE = 10;
const RECENT_PAGE_SIZE = 10;
const UPGRADE_HINT = '需升级现场助手（.80）后由助手回传';
const missingFieldHint = (title = UPGRADE_HINT) => (
  <span className="ac-upgrade-hint" title={title}>需升级现场助手（.80）</span>
);

/** 从房号（如 228/3/502、已隐藏228/3/502）解析楼栋号，用于默认勾选本楼栋。 */
function buildingNoFromRoomLabel(roomLabel?: string | null): string | null {
  const raw = String(roomLabel || '').replace(/已隐藏/g, '').trim();
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[1];
  if (parts.length === 2) return parts[0];
  return null;
}

const CARD_STATUS: Record<string, { text: string; tone: string }> = {
  pending: { text: '等放卡', tone: 'mute' },
  card_completed: { text: '已写卡', tone: 'ok' },
  card_failed: { text: '写卡失败', tone: 'dang' },
};
const cardStatusLabel = (v?: string | null) => CARD_STATUS[v || ''] ?? { text: v ? '处理中' : '—', tone: 'mute' };

const fmtCardTime = (value?: string | null) => value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
const actionText = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const cardActionResults = (raw: any): Array<{ name: string; ok: boolean; detail: string }> => {
  const source = raw?.systems ?? raw?.results ?? raw;
  const entries: Array<[string, any]> = Array.isArray(source)
    ? source.map((item: any) => [String(item?.system ?? item?.name ?? item?.key ?? 'system'), item])
    : source && typeof source === 'object' ? Object.entries(source) : [];
  return entries.map(([name, item]) => {
    const ok = item?.success === true || item?.ok === true || item?.status === 'succeeded' || item?.status === 'success' || item?.result === 'success';
    return { name, ok, detail: actionText(item?.message ?? item?.error ?? item?.reason ?? item?.detail ?? item?.result) || (ok ? '成功' : '失败') };
  });
};
const grantResultRows = (raw: any): Array<{ buildingNo: string; status: string; ok: boolean; detail: string }> => {
  const source = raw?.results ?? raw?.buildings ?? raw;
  const entries: Array<[string, any]> = Array.isArray(source)
    ? source.map((item: any, index: number) => [String(item?.buildingNo ?? item?.building ?? item?.no ?? index + 1), item])
    : source && typeof source === 'object' ? Object.entries(source) : [];
  return entries.map(([buildingNo, item]) => {
    const status = String(item?.status ?? item?.result ?? (item?.offline ? 'offline' : item?.success === false ? 'failed' : item?.success === true ? 'succeeded' : ''));
    const ok = item?.success === true || status === 'succeeded' || status === 'success' || status === 'ok';
    const label = ['offline', '待连', '未连接', 'unreachable'].includes(status) ? '离线' : ok ? '成功' : status === 'failed' || status === 'error' ? '失败' : status ? status : (ok ? '成功' : '失败');
    return { buildingNo, status: label, ok, detail: actionText(item?.message ?? item?.error ?? item?.reason ?? item?.detail) || (ok ? '成功' : label) };
  });
};

/** 简易分页：上一页 / 下一页 + 页码；只在数据超过一页时出现。 */
function Pager({ page, pageCount, total, onChange, testId }: {
  page: number; pageCount: number; total: number; onChange: (page: number) => void; testId?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="ac-pager" data-testid={testId}>
      <span className="muted">共 {total} 条 · 第 {page + 1}/{pageCount} 页</span>
      <button type="button" className="btn sm" disabled={page <= 0} onClick={() => onChange(page - 1)}>上一页</button>
      {Array.from({ length: pageCount }, (_, index) => index).map((index) => (
        <button type="button" key={index} className={`btn sm${index === page ? ' p' : ''}`} aria-current={index === page ? 'page' : undefined} onClick={() => onChange(index)}>{index + 1}</button>
      ))}
      <button type="button" className="btn sm" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>下一页</button>
    </div>
  );
}

/** 发卡历史 / 最近 30 笔共用 11 列表格；空字段显示升级提示，操作行内反馈。 */
function CardRecordsTable({
  rows, canEdit, cardDetails, applyBusyIds, applyState, onApply, onGrant,
}: {
  rows: CardRecordView[];
  canEdit: boolean;
  cardDetails: Record<number, CardDetail>;
  applyBusyIds: Record<number, boolean>;
  applyState: Record<number, { ok: boolean; error?: string }>;
  onApply: (row: CardRecordView) => void;
  onGrant: (row: CardRecordView) => void;
}) {
  return (
    <div className="t-scroll">
      <table className="t ac-history-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>编号</th>
            <th>房号</th>
            <th title={UPGRADE_HINT}>人事资料添加时间</th>
            <th>IC卡号</th>
            <th>WG卡号</th>
            <th>发卡时间</th>
            <th title={UPGRADE_HINT}>最后刷卡时间</th>
            <th title={UPGRADE_HINT}>出入口</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const detail = cardDetails[row.id];
            const hidden = !!row.hidden;
            const room = String(row.roomLabel || '').replace(/已隐藏/g, '').replace(/^[\s·\-]+/, '') || '—';
            const statusText = hidden ? '已隐藏' : (row.status || '—');
            const applied = applyState[row.id];
            const busy = !!applyBusyIds[row.id];
            return (
              <Fragment key={row.id}>
                <tr className={hidden ? 'ac-hidden-row' : undefined} data-card-id={row.id}>
                  <td className="nw muted">{row.displayNo}</td>
                  <td className="nw">{row.personNo || '—'}</td>
                  <td className="nw"><b>{room}</b>{hidden ? <span className="tag mute" style={{ marginLeft: 6 }}>已隐藏</span> : null}</td>
                  <td className="nw">{row.personCreatedAt ? fmtCardTime(row.personCreatedAt) : missingFieldHint()}</td>
                  <td className="nw">{row.icCardNo || '—'}</td>
                  <td className="nw">{row.wgCardNo || '—'}</td>
                  <td className="nw">{fmtCardTime(row.issuedAt)}</td>
                  <td className="nw">{row.lastSwipeAt ? fmtCardTime(row.lastSwipeAt) : missingFieldHint()}</td>
                  <td className="nw">{row.lastDevice || missingFieldHint()}</td>
                  <td className="nw">
                    <span className={'tag ' + (hidden ? 'mute' : 'ok')}>{statusText}</span>
                    {applied?.ok ? <span className="tag ok ac-applied-tag" style={{ marginLeft: 6 }}><Icon name="check" size={13} />已添加二期门禁系统</span> : null}
                    {applied && !applied.ok ? <small className="ac-apply-error" title={applied.error}>{applied.error || '添加失败'}</small> : null}
                  </td>
                  <td className="nw ac-actions">
                    {canEdit ? <>
                      <button className="btn sm ac-apply-btn" disabled={busy} onClick={() => onApply(row)}>
                        {busy ? '添加中…' : '添加到二期门禁系统'}
                      </button>
                      <button className="btn sm ac-grant-btn" onClick={() => onGrant(row)}>授权楼栋</button>
                    </> : '—'}
                  </td>
                </tr>
                {detail ? (
                  <tr className="ac-detail-row">
                    <td colSpan={11}>
                      <div className="ac-card-detail">
                        <span><b>已应用系统：</b>{(detail.appliedSystems ?? []).length ? (detail.appliedSystems ?? []).join('、') : '—'}</span>
                        <span><b>已授权楼栋：</b>{(detail.grantedBuildings ?? []).length ? (detail.grantedBuildings ?? []).join('、') : '—'}</span>
                        <span><b>最新任务：</b>{(detail.latestTasks ?? []).length ? (detail.latestTasks as any[]).map((task) => task?.status ?? task?.type ?? '—').join('、') : '—'}</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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
  const [history, setHistory] = useState<CardHistoryResp | null>(null);
  const [err, setErr] = useState('');
  const [issuer, setIssuer] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState(1);
  const [batch, setBatch] = useState<AccessCardIssueBatch | null>(null);
  const [busy, setBusy] = useState('');
  const timer = useRef<number | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyRetrying, setHistoryRetrying] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [recent, setRecent] = useState<CardRecentResp | null>(null);
  const [recentError, setRecentError] = useState('');
  const [recentRetry, setRecentRetry] = useState(0);
  const [grantCard, setGrantCard] = useState<CardHistoryRow | null>(null);
  const [grantMode, setGrantMode] = useState<'add' | 'remove'>('add');
  const [grantSearch, setGrantSearch] = useState('');
  const [grantSelected, setGrantSelected] = useState<string[]>([]);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantResults, setGrantResults] = useState<Array<{ buildingNo: string; status: string; ok: boolean; detail: string }> | null>(null);
  const [cardDetails, setCardDetails] = useState<Record<number, CardDetail>>({});
  // 新增状态一律追加在末尾：现有 VM harness 用例按 useState 下标固定注入状态，不能插到中间。
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(null);
  const [readinessError, setReadinessError] = useState('');
  const [readinessRetry, setReadinessRetry] = useState(0);
  // 最近做卡自动轮询用尽后置 true：仍 pending 时页面给一个「重试」入口，不能无声卡住。
  const [recentStalled, setRecentStalled] = useState(false);
  // 新增状态一律追加在末尾：现有 VM harness 用例按 useState 下标固定注入状态，不能插到中间。
  const [historyPage, setHistoryPage] = useState(0);
  const [recentPage, setRecentPage] = useState(0);
  const [applyBusyIds, setApplyBusyIds] = useState<Record<number, boolean>>({});
  const [applyState, setApplyState] = useState<Record<number, { ok: boolean; error?: string }>>({});
  const [grantOptions, setGrantOptions] = useState<GrantOption[]>([]);
  const [grantOptionsLoading, setGrantOptionsLoading] = useState(false);
  const [grantOptionsError, setGrantOptionsError] = useState('');
  const [grantHomeBuilding, setGrantHomeBuilding] = useState<string | null>(null);

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  useEffect(() => {
    let cancelled = false;
    setReadinessError('');
    accessCardIssuance.readiness()
      .then((r) => {
        if (cancelled) return;
        setReadiness(r ?? null);
        setReadinessError('');
        // 写卡工作站（issuer）只用于创建批次时指定工作站；是否存在看 features.cardWrite。
        const list = (r?.agents ?? []) as Array<{ id: string; kind: string; name?: string; status: string }>;
        const iss = list.find((a) => a.kind === 'issuer' && a.status === 'online') ?? null;
        setIssuer(iss ? { id: iss.id, name: iss.name || '发卡工作站' } : null);
      })
      .catch((e) => {
        if (cancelled) return;
        setReadiness(null);
        setIssuer(null);
        setReadinessError(e instanceof Error && e.message ? e.message : '门禁能力状态读取失败');
      });
    return () => { cancelled = true; };
  }, [readinessRetry]);

  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const loadHouse = useCallback((houseId: number) => {
    setCards(null); setErr('');
    request<{ accessCards: CardRow[] }>({ url: '/business/search', query: { q: '', serviceType: 'access_card' } })
      .then((r) => setCards((r?.accessCards ?? []).filter((c) => c.houseId === houseId)))
      .catch(() => setCards([]));
  }, []);

  const historyKey = JSON.stringify([picked?.communityId, picked?.lane, picked?.buildingNo, picked?.roomNo]);
  useEffect(() => {
    if (!picked?.houseId) { setCards(null); setHistory(null); setBatch(null); setHistoryError(''); setHistoryRetrying(false); return undefined; }
    loadHouse(picked.houseId);
    let cancelled = false;
    let attempts = 0;
    let retryTimer = 0;
    setHistory(null); setHistoryError(''); setHistoryRetrying(false);
    const addressText = [picked.lane, picked.buildingNo, picked.roomNo].filter(Boolean).join('/');
    const runHistory = async () => {
      try {
        const res = await request<CardHistoryResp>({ url: '/access-card-issuance/cards/history', query: { communityId: picked.communityId, address: addressText } });
        if (cancelled) return;
        if (res?.status === 'pending' && attempts < 3) {
          attempts += 1;
          setHistoryRetrying(true);
          retryTimer = window.setTimeout(() => void runHistory(), 3000);
          return;
        }
        setHistory(res);
        setHistoryRetrying(false);
      } catch (e) {
        if (cancelled) return;
        setHistoryError(e instanceof Error && e.message ? e.message : '发卡历史读取失败');
        setHistoryRetrying(false);
      }
    };
    void runHistory();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, [historyKey, historyRetry, loadHouse, picked]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = 0;
    let attempts = 0;
    setRecent(null); setRecentError(''); setRecentStalled(false);
    const run = async () => {
      try {
        const res = await request<CardRecentResp | CardRecent[]>({ url: '/access-card-issuance/cards/recent', query: { limit: 30 } });
        if (cancelled) return;
        // 旧后端可能直接返回数组；新后端返回 {status, rows, ...}，pending 时要轮询等助手回传。
        if (!res || Array.isArray(res) || typeof res !== 'object') {
          setRecent({ status: 'ready', rows: Array.isArray(res) ? res : [] });
          setRecentStalled(false);
          return;
        }
        setRecent(res);
        if (res.status === 'pending') {
          // 最多自动重试 5 次（1.5s/次）；用尽仍 pending 时保留旧行并露出「重试」，避免页面无声卡住。
          if (attempts < RECENT_POLL_MAX) {
            attempts += 1;
            retryTimer = window.setTimeout(() => void run(), RECENT_POLL_MS);
          } else {
            setRecentStalled(true);
          }
        } else {
          setRecentStalled(false);
        }
      } catch (e) {
        if (!cancelled) setRecentError(e instanceof Error && e.message ? e.message : '最近做卡记录读取失败');
      }
    };
    void run();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, [recentRetry]);

  const refreshCardDetail = useCallback(async (cardId: number) => {
    const detail = await request<CardDetail>({ url: '/access-card-issuance/cards/' + cardId });
    setCardDetails((prev) => ({ ...prev, [cardId]: detail }));
    return detail;
  }, []);

  /** 添加到二期门禁系统：不弹二次确认，直接 POST；成功后行内显示绿色状态，失败行内提示。 */
  const applyCardToAccess = async (card: CardRecordView) => {
    if (!canEdit || applyBusyIds[card.id]) return;
    setApplyBusyIds((prev) => ({ ...prev, [card.id]: true }));
    try {
      // 后端默认按该卡所属系统写入；行上带 accessSystem 时显式传，兼容旧后端。
      const data = card.accessSystem ? { systems: [card.accessSystem] } : {};
      await request<unknown>({ method: 'POST', url: `/access-card-issuance/cards/${card.id}/apply-mdb`, data });
      setApplyState((prev) => ({ ...prev, [card.id]: { ok: true } }));
      await refreshCardDetail(card.id);
      toast('已添加到二期门禁系统');
    } catch (e) {
      setApplyState((prev) => ({ ...prev, [card.id]: { ok: false, error: e instanceof Error && e.message ? e.message : '添加失败' } }));
    } finally {
      setApplyBusyIds((prev) => ({ ...prev, [card.id]: false }));
    }
  };

  const openGrant = async (card: CardRecordView) => {
    setGrantCard({ ...card } as unknown as CardHistoryRow);
    setGrantMode('add'); setGrantSearch(''); setGrantSelected([]); setGrantResults(null);
    setGrantOptions([]); setGrantOptionsLoading(true); setGrantOptionsError('');
    const parsedHome = buildingNoFromRoomLabel(card.roomLabel);
    setGrantHomeBuilding(card.homeBuildingNo || parsedHome);
    let detail: CardDetail | null = null;
    try { detail = await refreshCardDetail(card.id); } catch { /* 详情失败不影响授权面板 */ }
    const communityId = card.communityId ?? detail?.communityId ?? null;
    try {
      // 优先用后端 grant-options：已按该小区二期联网门禁收敛，并给出本房所在楼栋。
      const res = await request<{ homeBuildingNo?: string | null; options?: GrantOption[] }>({
        url: `/access-card-issuance/cards/${card.id}/grant-options`,
      });
      const options = Array.isArray(res?.options) ? res.options : [];
      const home = res?.homeBuildingNo || card.homeBuildingNo || parsedHome;
      setGrantOptions(options);
      setGrantHomeBuilding(home);
      setGrantSelected(home && options.some((item) => item.buildingNo === home) ? [home] : []);
    } catch {
      // 回退：设备管理同源的控制器列表，按 buildingNo 去重。
      if (communityId == null) {
        setGrantOptionsError('缺少小区信息，无法读取二期联网门禁门栋');
      } else {
        try {
          const ctl = await request<{ controllers?: Array<{ buildingNo?: string; doorName?: string; accessSystem?: string }> }>({
            url: '/access-card-issuance/door/controllers', query: { communityId },
          });
          const map = new Map<string, GrantOption>();
          for (const item of ctl?.controllers ?? []) {
            if (!item.buildingNo || map.has(item.buildingNo)) continue;
            map.set(item.buildingNo, { buildingNo: item.buildingNo, doorName: item.doorName ?? null, accessSystem: item.accessSystem ?? null });
          }
          const options = [...map.values()].sort((a, b) => a.buildingNo.localeCompare(b.buildingNo, 'zh-CN', { numeric: true }));
          const home = card.homeBuildingNo || parsedHome;
          setGrantOptions(options);
          setGrantHomeBuilding(home);
          setGrantSelected(home && options.some((item) => item.buildingNo === home) ? [home] : []);
        } catch (e) {
          setGrantOptionsError(e instanceof Error && e.message ? e.message : '读取二期联网门禁门栋失败');
        }
      }
    } finally {
      setGrantOptionsLoading(false);
    }
  };

  const submitGrant = async () => {
    if (!grantCard || grantBusy) return;
    if (!grantSelected.length) { setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: '请至少选择一栋楼' }]); return; }
    setGrantBusy(true);
    try {
      const raw = await request<unknown>({ method: 'POST', url: '/access-card-issuance/cards/' + grantCard.id + '/grant-boards', data: { buildingNos: grantSelected, mode: grantMode } });
      setGrantResults(grantResultRows(raw));
      await refreshCardDetail(grantCard.id);
    } catch (e) {
      setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: e instanceof Error ? e.message : '楼栋授权失败' }]);
    } finally { setGrantBusy(false); }
  };
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

  const historyRows = history?.rows ?? [];
  const recentRows = recent?.rows ?? [];
  const recentErrorText = recentError || (recent?.status === 'error' ? (recent.error || '最近做卡记录读取失败') : '');
  const fieldsIncomplete = !!history?.fieldsIncomplete || historyRows.some((row) => !row.personNo || !row.personCreatedAt || !row.icCardNo || !row.wgCardNo || !row.lastSwipeAt || !row.lastDevice);
  // 发卡历史按人事资料添加时间倒序；相同时间再按发卡时间/序号倒序。
  const sortedHistoryRows = useMemo(() => [...historyRows].sort((a, b) => {
    const createdA = a.personCreatedAt && dayjs(a.personCreatedAt).isValid() ? dayjs(a.personCreatedAt).valueOf() : -Infinity;
    const createdB = b.personCreatedAt && dayjs(b.personCreatedAt).isValid() ? dayjs(b.personCreatedAt).valueOf() : -Infinity;
    if (createdA !== createdB) return createdB - createdA;
    const issuedA = a.issuedAt && dayjs(a.issuedAt).isValid() ? dayjs(a.issuedAt).valueOf() : -Infinity;
    const issuedB = b.issuedAt && dayjs(b.issuedAt).isValid() ? dayjs(b.issuedAt).valueOf() : -Infinity;
    if (issuedA !== issuedB) return issuedB - issuedA;
    return (b.sequence ?? 0) - (a.sequence ?? 0);
  }), [history]);
  const historyTotal = sortedHistoryRows.length;
  const historyPageCount = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, historyPageCount - 1);
  const recentTotal = recentRows.length;
  const recentPageCount = Math.max(1, Math.ceil(recentTotal / RECENT_PAGE_SIZE));
  const safeRecentPage = Math.min(recentPage, recentPageCount - 1);
  useEffect(() => { setHistoryPage((page) => Math.min(page, Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1))); }, [historyTotal]);
  useEffect(() => { setRecentPage((page) => Math.min(page, Math.max(0, Math.ceil(recentTotal / RECENT_PAGE_SIZE) - 1))); }, [recentTotal]);
  const historyView: CardRecordView[] = sortedHistoryRows
    .slice(safeHistoryPage * HISTORY_PAGE_SIZE, safeHistoryPage * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE)
    .map((row, index) => ({ ...row, displayNo: historyTotal - (safeHistoryPage * HISTORY_PAGE_SIZE + index) }));
  const recentView: CardRecordView[] = recentRows
    .slice(safeRecentPage * RECENT_PAGE_SIZE, safeRecentPage * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE)
    .map((row, index) => ({
      ...row,
      communityId: row.communityId ?? picked?.communityId ?? null,
      displayNo: safeRecentPage * RECENT_PAGE_SIZE + index + 1,
    }));
  const visibleGrantOptions = grantOptions.filter((item) => (
    !grantSearch.trim()
    || item.buildingNo.includes(grantSearch.trim())
    || String(item.doorName || '').includes(grantSearch.trim())
  ));
  const capabilityTags = readinessCapabilityTags(readiness);

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="cards" /><h1 style={{ fontSize: 22 }}>门禁发卡</h1></div>
          <p>按户发卡、查卡与发卡历史；设备在线与远程开门已移到「设备管理」</p>
        </div>
        <div className="act ac-cap-abilities">
          {capabilityTags.length ? capabilityTags.map((tag) => (
            <span key={tag.key} className={`tag ${tag.ok ? 'ok' : 'warn'}`} title={tag.title}>
              <Icon name={tag.ok ? 'check' : 'alert'} />{tag.text}
            </span>
          )) : readinessError ? (
            <span className="tag warn" title={readinessError}><Icon name="alert" />门禁能力状态未知</span>
          ) : (
            <span className="tag mute"><Icon name="refresh" />门禁能力读取中…</span>
          )}
        </div>
      </div>

      <div className="findBar" style={{ marginBottom: 14 }}>
        <HousePicker communities={communities} value={picked}
          onPick={(p) => { setPicked(p); setBatch(null); }}
          onClear={() => { setPicked(null); setBatch(null); }}
          onIncomplete={() => toast('请再点一下具体室号：发卡要落到具体一户')} />
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{err}</div> : null}

      <div className="card" data-testid="recent-block" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <div className="panelHd" style={{ marginBottom: 10 }}>
          <b>最近 30 笔做卡记录</b>
          {recentRows.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{recentRows.length} 笔</span> : null}
          {recent?.status === 'pending' ? <span className="tag warn" style={{ marginLeft: 8 }}><Icon name="refresh" size={14} />助手回传中…</span> : null}
          {recent?.status === 'pending' && recentStalled ? (
            <button type="button" className="btn sm ac-recent-retry" style={{ marginLeft: 8 }} onClick={() => setRecentRetry((value) => value + 1)}>
              <Icon name="refresh" size={14} />重试
            </button>
          ) : null}
          {recent?.status === 'ready' && recent.refreshedAt ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>更新于 {dayjs(recent.refreshedAt).format('HH:mm')}</span> : null}
          {recent?.fieldsIncomplete ? <span className="ac-field-hint">部分字段需升级现场助手后显示</span> : null}
        </div>
        {recentErrorText ? (
          <div className="note2" role="alert" style={{ color: 'var(--dang)' }}><Icon name="alert" />{recentErrorText}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setRecentRetry((value) => value + 1)}>重试</button></div>
        ) : recent === null ? <Loading text="读最近做卡记录…" /> : null}
        {recent?.status === 'pending' && recentStalled && !recentErrorText ? (
          <div className="note2" style={{ marginBottom: 10 }}><Icon name="refresh" size={14} />助手回传较慢，已暂停自动刷新，可点「重试」继续查询。</div>
        ) : null}
        {recent && recentRows.length ? (
          <>
            <CardRecordsTable
              rows={recentView}
              canEdit={canEdit}
              cardDetails={cardDetails}
              applyBusyIds={applyBusyIds}
              applyState={applyState}
              onApply={(row) => void applyCardToAccess(row)}
              onGrant={(row) => void openGrant(row)}
            />
            <Pager page={safeRecentPage} pageCount={recentPageCount} total={recentTotal} onChange={setRecentPage} testId="recent-pager" />
          </>
        ) : recent && !recentErrorText && recent.status === 'ready' ? (
          <div className="muted">暂无最近做卡记录</div>
        ) : recent && !recentErrorText && recent.status === 'pending' && !recentStalled ? (
          <div className="muted"><Icon name="refresh" size={14} /> 助手回传中，稍后自动刷新…</div>
        ) : null}
      </div>

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
              <Icon name="alert" />{readiness === null
                ? (readinessError ? '门禁能力状态暂时读取失败，请刷新页面后重试。' : '正在读取门禁能力状态…')
                : readiness.features?.cardWrite
                  ? `写卡要读卡器，由${issuer ? `在线工作站「${issuer.name}」` : '工作站'}自动完成；本页负责建任务、看进度、下发失败单张重试。`
                  : '写卡工作站未接入，新卡暂不能写到读卡器；查发卡历史、写入 .88 门禁库和远程开门不受影响，等写卡工作站上线后再写卡。'}
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

          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>发卡历史</b>
              {historyRows.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{historyRows.length} 张</span> : null}
              {historyRetrying ? <span className="tag warn" style={{ marginLeft: 8 }}>助手回传中，3 秒后重试…</span> : null}
              {history?.refreshedAt ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>更新于 {fmtCardTime(history.refreshedAt)}</span> : null}
            </div>
            <div className="note2" style={{ marginBottom: 10 }}>
              <Icon name="alert" />数据来自捷顺系统；字段由现场助手回传。
              {fieldsIncomplete ? <span className="ac-field-hint">部分字段需升级现场助手后显示</span> : null}
            </div>
            {historyError ? (
              <div className="note2" role="alert" style={{ color: 'var(--dang)' }}>
                <Icon name="alert" />{historyError}
                <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setHistoryRetry((value) => value + 1)}>重试</button>
              </div>
            ) : history === null ? <Loading text="读发卡记录…" /> : historyRows.length === 0 ? (
              <div className="muted">该户在捷顺系统里没有发卡记录</div>
            ) : (
              <div data-testid="history-block">
                <CardRecordsTable
                  rows={historyView}
                  canEdit={canEdit}
                  cardDetails={cardDetails}
                  applyBusyIds={applyBusyIds}
                  applyState={applyState}
                  onApply={(row) => void applyCardToAccess(row)}
                  onGrant={(row) => void openGrant(row)}
                />
                <Pager page={safeHistoryPage} pageCount={historyPageCount} total={historyTotal} onChange={setHistoryPage} testId="history-pager" />
              </div>
            )}
          </div>





        </>
      )}
      <Sheet open={!!grantCard} onClose={() => { if (!grantBusy) setGrantCard(null); }} width={640} title="授权楼栋" subtitle={grantCard ? '卡 ' + (grantCard.icCardNo || grantCard.wgCardNo || '—') + ' · ' + (grantCard.roomLabel || '') : ''}>
        {grantCard ? (
          <>
            <div className="ac-grant-tools">
              <input className="in" placeholder="搜索楼栋 / 门名" value={grantSearch} onChange={(event) => setGrantSearch(event.target.value)} />
              <div className="chips">
                <button className={'chip ' + (grantMode === 'add' ? 'on' : '')} onClick={() => setGrantMode('add')}>添加权限</button>
                <button className={'chip ' + (grantMode === 'remove' ? 'on' : '')} onClick={() => setGrantMode('remove')}>撤销权限</button>
              </div>
            </div>
            {grantOptionsLoading ? <Loading text="读取该小区二期联网门禁门栋…" /> : grantOptionsError ? (
              <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{grantOptionsError}</div>
            ) : (
              <>
                {grantHomeBuilding ? (
                  <div className="note" style={{ marginBottom: 8 }}>
                    本房所在楼栋：<b>{grantHomeBuilding} 号楼</b>
                    {grantSelected.includes(grantHomeBuilding) ? ' · 已默认勾选' : ' · 不在该小区二期联网门禁范围'}
                  </div>
                ) : null}
                <div className="ac-building-list">
                  {visibleGrantOptions.map((building) => (
                    <label key={building.buildingNo} className="ac-building-item">
                      <input
                        type="checkbox"
                        data-grant-building={building.buildingNo}
                        checked={grantSelected.includes(building.buildingNo)}
                        onChange={(event) => setGrantSelected((prev) => event.target.checked ? [...prev, building.buildingNo] : prev.filter((no) => no !== building.buildingNo))}
                      />
                      <span>{building.buildingNo} 号楼{building.doorName ? ' · ' + building.doorName : ''}</span>
                    </label>
                  ))}
                  {!visibleGrantOptions.length ? <div className="muted">{grantSearch.trim() ? '没有匹配门栋' : '该小区没有可授权的二期联网门禁门栋'}</div> : null}
                </div>
              </>
            )}
            {grantResults ? (
              <div className="ac-results">
                {grantResults.map((result, index) => <div key={result.buildingNo + index} className={result.ok ? 'ok' : result.status === '离线' ? 'warn' : 'dang'}><b>{result.buildingNo} 号</b><span>{result.status}{result.detail && result.detail !== result.status ? ' · ' + result.detail : ''}</span></div>)}
              </div>
            ) : null}
            <div className="ac-dialog-foot">
              <button className="btn" disabled={grantBusy} onClick={() => setGrantCard(null)}>取消</button>
              <button className="btn p" disabled={grantBusy || grantOptionsLoading || !grantSelected.length} onClick={() => void submitGrant()}>{grantBusy ? '提交中…' : (grantMode === 'add' ? '确认授权' : '确认撤销')}</button>
            </div>
          </>
        ) : null}
      </Sheet>

    </>
  );
}
