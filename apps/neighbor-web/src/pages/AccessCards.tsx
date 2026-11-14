import { formatBeijingDateTime } from '@pms/shared-types';
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
  /** 已写入的二期门禁系统（后端 additive；有值=已添加）。 */
  appliedSystems?: string[] | null;
  /** 该行字段是否由现场助手完整回传；false/缺省时「空」代表该卡本来没有 .80 记录，不是助手没升级。 */
  fieldsIncomplete?: boolean;
}
interface CardHistoryResp { status: 'ready' | 'pending'; rows: CardHistoryRow[]; refreshedAt?: string; fieldsIncomplete?: boolean }
type CardRecent = {
  id: number; personNo?: string | null; sequence?: number; roomLabel: string; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
  accessSystem?: 'iccard' | 'mjsystem' | null; homeBuildingNo?: string | null;
  appliedSystems?: string[] | null;
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

interface LatestTask {
  id?: number | string;
  operation?: string | null;
  status?: string | null;
  requestedAt?: string | null;
  completedAt?: string | null;
  targetBuildings?: Array<{ buildingNo?: string | null; accessSystem?: string | null }> | null;
  controllerResults?: Array<Record<string, unknown>> | null;
  error?: string | null;
  acknowledgement?: string | null;
  databaseRecord?: string | null;
  groupName?: string | null;
}
interface PermissionBuildingDetail { buildingNo: string; granted?: boolean; source?: string | null }
interface CardDetail {
  id: number; appliedSystems?: string[]; grantedBuildings?: string[]; latestTasks?: LatestTask[];
  icCardNo?: string | null; wgCardNo?: string | null; roomLabel?: string | null; status?: string | null;
  communityId?: number | null; homeBuildingNo?: string | null; accessSystem?: 'iccard' | 'mjsystem' | null;
  permissionCheckedAt?: string | null; permissionSource?: string | null;
  grantedBuildingDetails?: PermissionBuildingDetail[] | null;
}
interface VerifyGrantState {
  busy: boolean; message?: string; error?: string; checkedAt?: string | null; grantedBuildings?: string[];
}

/** 发卡历史与最近 30 笔共用的行视图（11 列表格）；displayNo 为页面上显示的序号。 */
interface CardRecordView {
  id: number; personNo?: string | null; roomLabel: string; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
  accessSystem?: 'iccard' | 'mjsystem' | null; homeBuildingNo?: string | null; communityId?: number | null;
  appliedSystems?: string[] | null;
  /** 行级优先；缺省时回退到接口级 fieldsIncomplete。 */
  fieldsIncomplete?: boolean;
  displayNo: number;
}
/** 授权楼栋可选项：来自 grant-options（优先）或门禁控制器列表。 */
interface GrantOption { buildingNo: string; doorName?: string | null; accessSystem?: string | null }

const HISTORY_PAGE_SIZE = 10;
const RECENT_PAGE_SIZE = 10;
const UPGRADE_HINT = '需升级现场助手（.80）后由助手回传';
/**
 * 最后刷卡时间/出入口来自 .80 捷顺库 MC.LastBrushInfo，只到 2020 年；
 * 2021 年后二期换到 .88 Access 系统，新卡/近年卡在 .80 本来就没有刷卡记录，字段为空是正常的。
 * 只有 fieldsIncomplete=true（助手没回传字段）才提示升级；字段已回传时显示 — 并说明原因。
 */
const SWIPE_EMPTY_TITLE = '该卡无 .80 捷顺刷卡记录（2021 年后二期刷卡在 .88 门禁系统，暂未接入）';
const SWIPE_SOURCE_NOTE = '最后刷卡时间/出入口来自 .80 捷顺库最后一次刷卡；2021 年后二期门禁刷卡记录在 .88 系统，接入前显示 —。';
const SWIPE_HEADER_TITLE = '来自 .80 捷顺库最后一次刷卡；2021 年后二期刷卡在 .88 门禁系统，暂未接入，无记录显示 —。助手未回传字段时显示「需升级现场助手（.80）」';
const PERSON_CREATED_HEADER_TITLE = '人事资料添加时间由现场助手回传；未回传字段时显示「需升级现场助手（.80）」，本期无记录显示 —';
const PERSON_CREATED_EMPTY_TITLE = '该卡在 .80 捷顺人事资料中没有添加时间记录';
type CardFieldKey = 'personCreatedAt' | 'lastSwipeAt' | 'lastDevice';
const EMPTY_FIELD_TITLE: Record<CardFieldKey, string> = {
  personCreatedAt: PERSON_CREATED_EMPTY_TITLE,
  lastSwipeAt: SWIPE_EMPTY_TITLE,
  lastDevice: SWIPE_EMPTY_TITLE,
};
/** 空字段提示：接口/行标记 fieldsIncomplete 才提示升级助手，否则说明是 .80 无记录并显示 —。 */
function cardFieldHint(field: CardFieldKey, incomplete: boolean) {
  if (incomplete) {
    return (
      <span className="ac-upgrade-hint" title={UPGRADE_HINT} data-empty-field={field} data-upgrade-hint="true">
        {'需升级现场助手（.80）'}
      </span>
    );
  }
  return <span className="ac-empty-dash muted" title={EMPTY_FIELD_TITLE[field]} data-empty-field={field}>—</span>;
}

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

const fmtCardTime = (value?: string | null) => value && dayjs(value).isValid() ? formatBeijingDateTime(value, 'YYYY-MM-DD HH:mm') : '—';
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

/** 授权任务：后端 history-authorizations/:id 的对外形态（additive 字段可选）。 */
interface GrantTask {
  id: number | string;
  operation?: string | null;
  status?: string | null;
  requestedAt?: string | null;
  completedAt?: string | null;
  targetBuildings?: Array<{ buildingNo?: string | null; accessSystem?: string | null }> | null;
  controllerResults?: Array<Record<string, unknown>> | null;
  error?: string | null;
  acknowledgement?: string | null;
  databaseRecord?: string | null;
  groupName?: string | null;
}

const TASK_STATUS_CN: Record<string, string> = {
  pending: '待处理', running: '执行中', sent: '执行中', completed: '已完成', succeeded: '已完成', failed: '失败', cancelled: '已取消',
};
const TASK_OPERATION_CN: Record<string, string> = {
  access_database_only: '写入 Access 库', controller_upload: '授权楼栋', controller_revoke: '撤销楼栋',
  remote_open: '远程开门', temporary_open: '常开', restore_normal: '恢复常开', controller_detect: '控制器检测',
  apply_mdb: '写入 Access 库', grant_boards: '授权楼栋', revoke_boards: '撤销楼栋',
};
const TASK_STATUS_TONE: Record<string, string> = { pending: 'warn', running: 'blue', sent: 'blue', completed: 'ok', succeeded: 'ok', failed: 'dang', cancelled: 'mute' };
const taskStatusCN = (status?: string | null) => (status ? TASK_STATUS_CN[status] || '未知状态' : '—');
const taskOperationCN = (operation?: string | null) => (operation ? TASK_OPERATION_CN[operation] || '其他门禁任务' : '—');
const taskStatusTone = (status?: string | null) => TASK_STATUS_TONE[status || ''] || 'mute';
/** 后端真实成功状态（不能只认 success/ok，生产用 controller_uploaded/access_db_written 等）。 */
const RESULT_OK = new Set([
  'success', 'succeeded', 'ok', 'completed', 'done', 'applied',
  'controller_uploaded', 'access_db_written', 'controller_removed', 'controller_detected',
  'door_opened', 'door_held_open', 'door_restored', 'access_db_updated',
]);
const RESULT_OFFLINE = new Set(['offline', 'controller_offline', 'unreachable', 'not_connected', '待连', '未连接']);
const RESULT_FAILED = new Set(['controller_failed', 'access_db_failed', 'failed', 'error', 'timeout', 'door_failed']);
function resultState(rawStatus: string): { ok: boolean; label: string } {
  if (RESULT_OK.has(rawStatus)) return { ok: true, label: '成功' };
  if (RESULT_OFFLINE.has(rawStatus)) return { ok: false, label: '离线' };
  if (RESULT_FAILED.has(rawStatus)) return { ok: false, label: '失败' };
  return { ok: false, label: rawStatus ? '处理中' : '处理中' };
}
const DB_OPERATIONS = new Set(['access_database_only', 'apply_mdb']);
interface TaskLogRow { time: string; sortAt: number; operation: string; buildingNo: string; status: string; ok: boolean; detail: string }
/** 简短日志流水：每个动作一行，Access 库写入与控制器回执严格分开；倒序由调用方保证。 */
function taskLogRows(tasks: LatestTask[]): TaskLogRow[] {
  const rows: TaskLogRow[] = [];
  for (const task of tasks) {
    const operation = taskOperationCN(task.operation);
    const isDb = DB_OPERATIONS.has(String(task.operation || ''));
    const at = task.completedAt || task.requestedAt || '';
    const time = fmtCardTime(at);
    const sortAt = at ? new Date(at).getTime() || 0 : 0;
    const results = Array.isArray(task.controllerResults) ? task.controllerResults : [];
    if (results.length) {
      results.forEach((item, index) => {
        const rawStatus = String(item?.status ?? item?.result ?? '');
        const state = resultState(rawStatus);
        const detailRaw = isDb
          ? (item?.databaseRecord ?? item?.groupName ?? item?.error ?? task.error ?? '')
          : (item?.acknowledgement ?? item?.error ?? item?.reason ?? task.error ?? '');
        rows.push({
          time, sortAt, operation, buildingNo: String(item?.buildingNo ?? item?.building ?? task.targetBuildings?.[index]?.buildingNo ?? '—'),
          status: state.label, ok: state.ok, detail: actionText(detailRaw) || state.label,
        });
      });
      continue;
    }
    const taskCompleted = task.status === 'completed' || task.status === 'succeeded';
    const detailRaw = isDb ? (task.databaseRecord ?? task.groupName ?? task.error ?? '') : (task.acknowledgement ?? task.error ?? '');
    rows.push({
      time, sortAt, operation,
      buildingNo: (task.targetBuildings ?? []).map((item) => item.buildingNo).filter(Boolean).join('、') || '—',
      status: task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : taskCompleted ? '成功' : taskStatusCN(task.status),
      ok: taskCompleted, detail: actionText(detailRaw) || (taskCompleted ? '成功' : task.status === 'failed' ? '失败' : '处理中'),
    });
  }
  return rows.sort((a, b) => b.sortAt - a.sortAt);
}
const SYSTEM_CN: Record<string, string> = { iccard: 'IC 卡门禁', mjsystem: 'MjSystem 门禁' };
const systemCN = (value?: string | null) => (value ? SYSTEM_CN[value] || '门禁系统' : '—');
/** 权限来源/表名尽量中文化，未知值原样保留（避免伪造）。 */
function permissionSourceCN(source?: string | null): string {
  if (!source) return '—';
  if (/access_permission|t_d_Privilege|^t88$|\.88/i.test(source)) return 'Access 权限表';
  if (/legacy|80/.test(source)) return '.80 捷顺库';
  return source;
}

/** 逐栋控制器回执 -> 中文结果行。 */
function taskBuildingResults(task: LatestTask | GrantTask): Array<{ buildingNo: string; ok: boolean; status: string; detail: string }> {
  const results = Array.isArray(task.controllerResults) ? task.controllerResults : [];
  if (results.length) {
    return results.map((item, index) => {
      const rawStatus = String(item?.status ?? item?.result ?? '');
      const state = resultState(rawStatus);
      const ok = state.ok;
      const statusCn = state.label;
      const detail = actionText(item?.acknowledgement ?? item?.message ?? item?.error ?? item?.reason ?? '') || statusCn;
      return { buildingNo: String(item?.buildingNo ?? item?.building ?? index + 1), ok, status: statusCn, detail };
    });
  }
  if (Array.isArray(task.targetBuildings) && task.targetBuildings.length) {
    const taskStatus = task.status || '';
    const ok = taskStatus === 'completed' || taskStatus === 'succeeded';
    return task.targetBuildings.map((building) => ({
      buildingNo: String(building?.buildingNo ?? '—'),
      ok,
      status: ok ? '成功' : taskStatusCN(taskStatus),
      detail: taskStatusCN(taskStatus),
    }));
  }
  return [];
}

/** 任务列表 + 提交返回 results -> 逐栋中文结果（无控制器回执时回退提交结果）。 */
function grantRowsFromTasks(tasks: GrantTask[], fallback: Array<{ buildingNo: string; status: string; ok: boolean; detail: string }>) {
  const rows = tasks.flatMap((task) => taskBuildingResults(task));
  const source = rows.length ? rows : fallback;
  // 多任务可能包含同一楼栋（旧后端每个系统一条任务），逐栋结果去重；失败/离线优先展示。
  const byBuilding = new Map<string, { buildingNo: string; ok: boolean; status: string; detail: string }>();
  for (const row of source) {
    const existing = byBuilding.get(row.buildingNo);
    if (!existing || (existing.ok && !row.ok)) byBuilding.set(row.buildingNo, row);
  }
  return [...byBuilding.values()];
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
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

/** 发卡历史 / 最近 30 笔共用 11 列表格；空字段按 fieldsIncomplete 提示升级或显示 —，操作行内反馈。 */
export function CardRecordsTable({
  rows, canEdit, cardDetails, applyBusyIds, applyState, verifyState, expandedId, onToggle, onApply, onGrant, onVerify,
}: {
  rows: CardRecordView[];
  canEdit: boolean;
  cardDetails: Record<number, CardDetail>;
  applyBusyIds: Record<number, boolean>;
  applyState: Record<number, { ok: boolean; error?: string }>;
  verifyState: Record<number, VerifyGrantState>;
  expandedId: number | null;
  onToggle: (row: CardRecordView) => void;
  onApply: (row: CardRecordView) => void;
  onGrant: (row: CardRecordView) => void;
  onVerify: (cardId: number) => void;
}) {
  return (
    <div className="t-scroll">
      <table className="t ac-history-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>编号</th>
            <th>房号</th>
            <th title={PERSON_CREATED_HEADER_TITLE}>人事资料添加时间</th>
            <th>IC卡号</th>
            <th>WG卡号</th>
            <th>发卡时间</th>
            <th title={SWIPE_HEADER_TITLE}>最后刷卡时间</th>
            <th title={SWIPE_HEADER_TITLE}>出入口</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const detail = cardDetails[row.id];
            const incomplete = row.fieldsIncomplete === true;
            const room = String(row.roomLabel || '').replace(/已隐藏/g, '').replace(/^[\s·\-]+/, '') || '—';
            const statusText = row.status || '在用';
            const applied = applyState[row.id]?.ok === true
              || (row.appliedSystems?.length ?? 0) > 0
              || (detail?.appliedSystems?.length ?? 0) > 0;
            const appliedError = applyState[row.id] && !applyState[row.id].ok ? (applyState[row.id].error || '添加失败') : '';
            const busy = !!applyBusyIds[row.id];
            return (
              <Fragment key={row.id}>
                <tr className="ac-clickable-row" data-card-id={row.id} data-expanded={expandedId === row.id ? 'true' : 'false'} onClick={() => onToggle(row)}>
                  <td className="nw muted">{row.displayNo}<span className="ac-expand-arrow" aria-hidden="true">{expandedId === row.id ? '▾' : '▸'}</span></td>
                  <td className="nw">{row.personNo || '—'}</td>
                  <td className="nw"><b>{room}</b></td>
                  <td className="nw">{row.personCreatedAt ? fmtCardTime(row.personCreatedAt) : cardFieldHint('personCreatedAt', incomplete)}</td>
                  <td className="nw">{row.icCardNo || '—'}</td>
                  <td className="nw">{row.wgCardNo || '—'}</td>
                  <td className="nw">{fmtCardTime(row.issuedAt)}</td>
                  <td className="nw">{row.lastSwipeAt ? fmtCardTime(row.lastSwipeAt) : cardFieldHint('lastSwipeAt', incomplete)}</td>
                  <td className="nw">{row.lastDevice || cardFieldHint('lastDevice', incomplete)}</td>
                  <td className="nw">
                    <span className="tag ok">{statusText}</span>
                  </td>
                  <td className="nw ac-actions">
                    {canEdit ? <>
                      {applied ? (
                        <button type="button" className="btn sm ac-applied-btn" data-testid="apply-btn" data-applied="true" disabled onClick={(event) => event.stopPropagation()}>
                          <Icon name="check" size={14} />已添加二期门禁系统
                        </button>
                      ) : (
                        <button type="button" className="btn sm ac-apply-btn" data-testid="apply-btn" data-applied="false" disabled={busy} onClick={(event) => { event.stopPropagation(); onApply(row); }}>
                          {busy ? '添加中…' : '添加到二期门禁系统'}
                        </button>
                      )}
                      <button className="btn sm ac-grant-btn" onClick={(event) => { event.stopPropagation(); onGrant(row); }}>授权楼栋</button>
                      {appliedError ? <small className="ac-apply-error" title={appliedError}>{appliedError}</small> : null}
                    </> : '—'}
                  </td>
                </tr>
                {expandedId === row.id ? (
                  <tr className="ac-detail-row">
                    <td colSpan={11}>
                      {detail ? (
                      <div className="ac-card-detail">
                        <span><b>已应用系统：</b>{(detail.appliedSystems ?? []).length ? (detail.appliedSystems ?? []).map(systemCN).join('、') : '—'}</span>
                        <span><b>已授权楼栋：</b>{(detail.grantedBuildings ?? []).length ? (detail.grantedBuildings ?? []).join('、') : '—'}</span>
                        <div className="ac-detail-note">
                          说明：「成功」= 控制器回执确认（不是仅入队）；「已验证」= 读回 .88 门禁权限表成功后才算。
                        </div>
                        <div className="ac-log-list" data-testid="task-log">
                          <b>操作日志（最新在上）</b>
                          {taskLogRows(detail.latestTasks ?? []).length ? (
                            taskLogRows(detail.latestTasks ?? []).map((log, index) => (
                              <div key={`${log.time}-${log.operation}-${log.buildingNo}-${index}`} className={`ac-log-line ${log.ok ? 'ok' : log.status === '离线' ? 'warn' : 'dang'}`} data-testid="task-log-line" data-ok={log.ok ? 'true' : 'false'} data-operation={log.operation}>
                                <span className="ac-log-time">{log.time}</span>
                                <span className="ac-log-sep">·</span>
                                <span className="ac-log-op">{log.operation}</span>
                                <span className="ac-log-sep">·</span>
                                <span className="ac-log-building">{log.buildingNo} 号楼</span>
                                <span className="ac-log-sep">·</span>
                                <span className="ac-log-status">{log.status}</span>
                                <span className="ac-log-sep">·</span>
                                <span className="ac-log-detail" title={log.detail}>{log.detail}</span>
                              </div>
                            ))
                          ) : <small className="muted">暂无日志</small>}
                        </div>
                        <div className="ac-permission" data-testid="permission-block">
                          <div className="ac-permission-head">
                            <b>权限读回</b>
                            <span className="muted">核验时间：{fmtCardTime(verifyState[row.id]?.checkedAt ?? detail.permissionCheckedAt)}</span>
                            <span className="muted">来源：{permissionSourceCN(verifyState[row.id]?.message ? 'access_permission' : detail.permissionSource)}</span>
                            <button type="button" className="btn sm" data-testid="verify-grant-btn" disabled={!canEdit || verifyState[row.id]?.busy} onClick={(event) => { event.stopPropagation(); onVerify(row.id); }}>
                              {verifyState[row.id]?.busy ? '核验中…' : '重新核验权限'}
                            </button>
                          </div>
                          {(detail.grantedBuildingDetails ?? []).length ? (
                            <div className="ac-permission-buildings">
                              {(detail.grantedBuildingDetails ?? []).map((item) => (
                                <span key={item.buildingNo} className={item.granted ? 'ok' : 'dang'} data-building-no={item.buildingNo}>
                                  {item.buildingNo} 号楼：{item.granted === false ? '未授权' : '已授权'}{item.source ? ` · 来源 ${permissionSourceCN(item.source)}` : ''}
                                </span>
                              ))}
                            </div>
                          ) : <div className="muted">暂无逐栋权限读回明细，可点「重新核验权限」。</div>}
                          {verifyState[row.id]?.grantedBuildings?.length ? (
                            <div className="ac-permission-result ok">核验读回楼栋：{verifyState[row.id]!.grantedBuildings!.join('、')}</div>
                          ) : null}
                          {verifyState[row.id]?.message ? <div className="ac-permission-result ok">{verifyState[row.id]!.message}</div> : null}
                          {verifyState[row.id]?.error ? <div className="ac-permission-result dang">{verifyState[row.id]!.error}</div> : null}
                        </div>
                      </div>
                      ) : <div className="muted" data-testid="card-detail-loading">读取详情…</div>}
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
  const [grantPolling, setGrantPolling] = useState(false);
  const [grantFailed, setGrantFailed] = useState(false);
  const [grantError, setGrantError] = useState('');
  const [verifyState, setVerifyState] = useState<Record<number, VerifyGrantState>>({});
  const [expandedCardId, setExpandedCardId] = useState<number | null>(null);
  const [recentOpen, setRecentOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('access.recent.open') === '1'; } catch { return false; }
  });
  const toggleRecent = () => setRecentOpen((open) => {
    const next = !open;
    try { localStorage.setItem('access.recent.open', next ? '1' : '0'); } catch { /* 忽略存储失败 */ }
    return next;
  });

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
    if (!recentOpen) return undefined;
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
  }, [recentRetry, recentOpen]);

  const refreshCardDetail = useCallback(async (cardId: number) => {
    const detail = await request<CardDetail>({ url: '/access-card-issuance/cards/' + cardId });
    setCardDetails((prev) => ({ ...prev, [cardId]: detail }));
    return detail;
  }, []);

  /** 默认折叠：点行展开日志；首次展开才拉详情，操作按钮已 stopPropagation 不触发展开。 */
  const toggleCardDetail = (row: CardRecordView) => {
    if (expandedCardId === row.id) { setExpandedCardId(null); return; }
    setExpandedCardId(row.id);
    if (!cardDetails[row.id]) void refreshCardDetail(row.id).catch(() => undefined);
  };

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
    setGrantPolling(false); setGrantFailed(false); setGrantError('');
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

  /** 轮询任务到 completed/failed，最长 90 秒；返回最终任务或超时。 */
  const pollGrantTasks = async (taskIds: number[]) => {
    const deadline = Date.now() + 90000;
    let latest: GrantTask[] = [];
    while (Date.now() < deadline) {
      latest = await Promise.all(taskIds.map((taskId) => request<GrantTask>({
        url: '/access-card-issuance/history-authorizations/' + taskId,
      })));
      if (latest.every((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) return latest;
      await sleep(1800);
    }
    return 'timeout' as const;
  };

  const submitGrant = async () => {
    if (!grantCard || grantBusy) return;
    if (!grantSelected.length) { setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: '请至少选择一栋楼' }]); return; }
    setGrantBusy(true); setGrantFailed(false); setGrantError(''); setGrantPolling(false);
    try {
      const raw = await request<{ taskIds?: number[]; results?: unknown[] }>({
        method: 'POST', url: '/access-card-issuance/cards/' + grantCard.id + '/grant-boards',
        data: { buildingNos: grantSelected, mode: grantMode },
      });
      const fallback = grantResultRows(raw);
      setGrantResults(fallback);
      const taskIds = Array.isArray(raw?.taskIds) ? raw.taskIds.filter((id): id is number => Number.isFinite(Number(id))) : [];
      if (!taskIds.length) {
        // 旧后端只返回入队结果：保持弹窗，提示以控制器回执为准。
        setGrantFailed(true);
        setGrantError('提交已入队，但后端未返回任务编号，无法确认控制器回执；请稍后刷新详情查看最新任务。');
        return;
      }
      setGrantPolling(true);
      const tasks = await pollGrantTasks(taskIds);
      if (tasks === 'timeout') {
        setGrantFailed(true);
        setGrantError('等待控制器回执超时（已轮询 90 秒），任务可能仍在执行；请稍后刷新详情或重新提交。');
        return;
      }
      const rows = grantRowsFromTasks(tasks, fallback);
      setGrantResults(rows);
      const allCompleted = tasks.every((task) => task.status === 'completed');
      const refreshed = await refreshCardDetail(grantCard.id);
      const granted = (refreshed?.grantedBuildings ?? []).map(String);
      const allGranted = grantSelected.every((buildingNo) => granted.includes(String(buildingNo)));
      if (allCompleted && allGranted) {
        toast(`授权完成：${grantSelected.length} 栋已生效（已读回 .88 门禁权限表）`);
        setGrantCard(null);
        setGrantResults(null);
        setGrantFailed(false);
        setGrantPolling(false);
        return;
      }
      setGrantFailed(true);
      setGrantError(allCompleted
        ? '控制器已回执，但 .88 权限表未读回全部所选楼栋；请点「重新核验权限」或重新提交。'
        : '部分楼栋执行失败/离线，请查看逐栋中文结果后重新提交。');
    } catch (e) {
      setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: e instanceof Error ? e.message : '楼栋授权失败' }]);
      setGrantFailed(true);
      setGrantError(e instanceof Error && e.message ? e.message : '楼栋授权失败');
    } finally {
      setGrantBusy(false); setGrantPolling(false);
    }
  };

  const verifyGrant = async (cardId: number) => {
    setVerifyState((prev) => ({ ...prev, [cardId]: { ...(prev[cardId] ?? {}), busy: true, error: '' } }));
    try {
      const raw = await request<{ checkedAt?: string | null; grantedBuildings?: string[]; message?: string | null; success?: boolean; ok?: boolean }>({
        method: 'POST', url: `/access-card-issuance/cards/${cardId}/verify-grant`,
      });
      const granted = Array.isArray(raw?.grantedBuildings) ? raw.grantedBuildings.map(String) : [];
      setVerifyState((prev) => ({
        ...prev,
        [cardId]: {
          busy: false,
          checkedAt: raw?.checkedAt ?? null,
          grantedBuildings: granted,
          message: raw?.message || `核验完成：已读回 ${granted.length} 栋权限`,
          error: '',
        },
      }));
      await refreshCardDetail(cardId);
    } catch (e) {
      setVerifyState((prev) => ({
        ...prev,
        [cardId]: { ...(prev[cardId] ?? {}), busy: false, error: e instanceof Error && e.message ? e.message : '权限核验失败，请稍后重试' },
      }));
    }
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
  // 只有接口或行明确标记 fieldsIncomplete 才提示升级；不能再用「lastSwipeAt 为空」推断，
  // 否则新卡/近年卡（.80 本就没有刷卡记录）会被误报成助手没升级。
  const fieldsIncomplete = !!history?.fieldsIncomplete || historyRows.some((row) => row.fieldsIncomplete === true);
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
    .map((row, index) => ({
      ...row,
      fieldsIncomplete: row.fieldsIncomplete === true || !!history?.fieldsIncomplete,
      displayNo: historyTotal - (safeHistoryPage * HISTORY_PAGE_SIZE + index),
    }));
  const recentView: CardRecordView[] = recentRows
    .slice(safeRecentPage * RECENT_PAGE_SIZE, safeRecentPage * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE)
    .map((row, index) => ({
      ...row,
      communityId: row.communityId ?? picked?.communityId ?? null,
      fieldsIncomplete: row.fieldsIncomplete === true || !!recent?.fieldsIncomplete,
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

      <div className="note2 ac-swipe-note" data-testid="swipe-source-note" style={{ marginBottom: 14 }}>
        <Icon name="alert" size={14} />{SWIPE_SOURCE_NOTE}
      </div>

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
                  verifyState={verifyState}
                  expandedId={expandedCardId}
                  onToggle={toggleCardDetail}
                  onApply={(row) => void applyCardToAccess(row)}
                  onGrant={(row) => void openGrant(row)}
                  onVerify={(cardId) => void verifyGrant(cardId)}
                />
                <Pager page={safeHistoryPage} pageCount={historyPageCount} total={historyTotal} onChange={setHistoryPage} testId="history-pager" />
              </div>
            )}
          </div>





        </>
      )}
      <div className="card" data-testid="recent-block" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <div className="panelHd ac-recent-head" style={{ marginBottom: recentOpen ? 10 : 0, cursor: 'pointer' }} onClick={toggleRecent}>
          <b>最近 30 笔做卡记录</b>
          <span className="tag mute" style={{ marginLeft: 8 }}>{recentRows.length || 30} 笔</span>
          {recent?.status === 'pending' ? <span className="tag warn" style={{ marginLeft: 8 }}><Icon name="refresh" size={14} />助手回传中…</span> : null}
          {recent?.status === 'pending' && recentStalled ? (
            <button type="button" className="btn sm ac-recent-retry" style={{ marginLeft: 8 }} onClick={(event) => { event.stopPropagation(); setRecentRetry((value) => value + 1); }}>
              <Icon name="refresh" size={14} />重试
            </button>
          ) : null}
          {recent?.status === 'ready' && recent.refreshedAt ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>更新于 {formatBeijingDateTime(recent.refreshedAt, 'HH:mm')}</span> : null}
          {recent?.fieldsIncomplete ? <span className="ac-field-hint">部分字段需升级现场助手后显示</span> : null}
          <button type="button" className="btn sm" data-testid="recent-toggle" style={{ marginLeft: 'auto' }} aria-expanded={recentOpen} onClick={(event) => { event.stopPropagation(); toggleRecent(); }}>
            {recentOpen ? '收起 ▾' : '展开 ▸'}
          </button>
        </div>
        {recentOpen ? (
          <>
            {recentErrorText ? (
              <div className="note2" role="alert" style={{ color: 'var(--dang)' }}><Icon name="alert" />{recentErrorText}<button className="btn sm" style={{ marginLeft: 10 }} onClick={(event) => { event.stopPropagation(); setRecentRetry((value) => value + 1); }}>重试</button></div>
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
                  verifyState={verifyState}
                  expandedId={expandedCardId}
                  onToggle={toggleCardDetail}
                  onApply={(row) => void applyCardToAccess(row)}
                  onGrant={(row) => void openGrant(row)}
                  onVerify={(cardId) => void verifyGrant(cardId)}
                />
                <Pager page={safeRecentPage} pageCount={recentPageCount} total={recentTotal} onChange={setRecentPage} testId="recent-pager" />
              </>
            ) : recent && !recentErrorText && recent.status === 'ready' ? (
              <div className="muted">暂无最近做卡记录</div>
            ) : recent && !recentErrorText && recent.status === 'pending' && !recentStalled ? (
              <div className="muted"><Icon name="refresh" size={14} /> 助手回传中，稍后自动刷新…</div>
            ) : null}
          </>
        ) : <div className="muted" style={{ fontSize: 12 }}>最近做卡记录默认折叠，点「展开」后加载。</div>}
      </div>

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
            {grantPolling ? <div className="note2" data-testid="grant-polling"><Icon name="refresh" size={14} />正在轮询控制器回执（间隔 1.8 秒，最长 90 秒）…「已完成」以后端控制器回执为准。</div> : null}
            {grantError ? <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }} data-testid="grant-error"><Icon name="alert" />{grantError}</div> : null}
            {grantResults ? (
              <div className="ac-results">
                {grantResults.map((result, index) => <div key={result.buildingNo + index} className={result.ok ? 'ok' : result.status === '离线' ? 'warn' : 'dang'}><b>{result.buildingNo} 号</b><span>{result.status}{result.detail && result.detail !== result.status ? ' · ' + result.detail : ''}</span></div>)}
              </div>
            ) : null}
            <div className="ac-dialog-foot">
              <button className="btn" disabled={grantBusy} onClick={() => setGrantCard(null)}>取消</button>
              <button className="btn p" disabled={grantBusy || grantOptionsLoading || !grantSelected.length} onClick={() => void submitGrant()}>
                {grantBusy ? (grantPolling ? '等待控制器回执…' : '提交中…') : grantFailed ? '重新提交' : (grantMode === 'add' ? '确认授权' : '确认撤销')}
              </button>
            </div>
          </>
        ) : null}
      </Sheet>

    </>
  );
}
