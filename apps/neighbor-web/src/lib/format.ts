import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { WorkOrderStatus } from '@pms/shared-types';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export { dayjs };

/** 设计稿的统一状态字典：全系统只用这一套名字和颜色 */
export const STATUS = {
  [WorkOrderStatus.CREATED]: { name: '待派单', cls: 's-pend', col: '办公室派单' },
  /** 不是数据库状态：已自动派给匹配的维修工（candidateIds）或已指定给某人（DISPATCHED），等维修工接单 */
  pending_accept: { name: '待接单', cls: 's-wait', col: '维修工接单' },
  [WorkOrderStatus.DISPATCHED]: { name: '待接单', cls: 's-wait', col: '维修工接单' },
  [WorkOrderStatus.IN_PROGRESS]: { name: '维修中', cls: 's-work', col: '现场处理' },
  [WorkOrderStatus.WAITING_MATERIAL]: { name: '等材料', cls: 's-mat', col: '采购/领料' },
  [WorkOrderStatus.DONE_PENDING_REVIEW]: { name: '待验收', cls: 's-acc', col: '业主确认' },
  [WorkOrderStatus.COMPLETED]: { name: '已完成', cls: 's-done', col: '已归档' },
  [WorkOrderStatus.CANCELLED]: { name: '已关闭', cls: 's-off', col: '已归档' },
  [WorkOrderStatus.VOIDED]: { name: '已作废', cls: 's-off', col: '已归档' },
} as const;

export type StatusKey = keyof typeof STATUS;

export function statusOf(s: string) {
  return STATUS[s as StatusKey] ?? { name: s, cls: 's-off', col: '' };
}

/** 进行中的状态（看板五列） */
export const BOARD_COLUMNS: string[] = [
  WorkOrderStatus.CREATED,
  'pending_accept',
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
  WorkOrderStatus.DONE_PENDING_REVIEW,
];

export const ACTIVE_STATUSES: string[] = BOARD_COLUMNS.filter((s) => s !== 'pending_accept');

/**
 * 调度台上的环节，只分两档「派没派出去」：
 *   待派单 = 没识别出工种、或这个工种没配维修工 —— 没有任何去向，要办公室派；
 *   待接单 = 已派出去等维修工接：按工种自动派给匹配的维修工（candidateIds），或办公室指定给某人（dispatched）。
 */
export function stageOf(o: { status: string; candidateIds?: number[] | null; assigneeId?: number | null }): string {
  if (o.status === WorkOrderStatus.DISPATCHED) return 'pending_accept';
  if (o.status === WorkOrderStatus.CREATED && (o.assigneeId || (o.candidateIds?.length ?? 0) > 0)) return 'pending_accept';
  return o.status;
}

export function isActive(status: string) {
  return ACTIVE_STATUSES.includes(status as WorkOrderStatus);
}

/** 超过要求完成时间且没完工 */
export function isOverdue(o: { slaDueAt?: string | null; status: string }) {
  if (!o.slaDueAt || !isActive(o.status)) return false;
  return dayjs(o.slaDueAt).isBefore(dayjs());
}

export function ago(iso?: string | null) {
  if (!iso) return '—';
  return dayjs(iso).fromNow();
}

export function dueText(iso?: string | null) {
  if (!iso) return '—';
  const d = dayjs(iso);
  const today = dayjs().endOf('day');
  if (d.isBefore(dayjs())) return `${d.format('MM-DD HH:mm')} · 已超时`;
  if (d.isBefore(today)) return `今天 ${d.format('HH:mm')}`;
  if (d.isBefore(today.add(1, 'day'))) return `明天 ${d.format('HH:mm')}`;
  return d.format('MM-DD HH:mm');
}

export function money(v?: number | string | null) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '¥ 0.00';
  return `¥ ${n.toFixed(2)}`;
}

/** 手机号/姓名脱敏展示，和设计稿一致 */
export function maskPhone(phone?: string | null) {
  if (!phone) return '—';
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}
