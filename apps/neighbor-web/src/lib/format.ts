import { formatBeijingDateTime } from '@pms/shared-types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { WorkOrderStatus } from '@pms/shared-types';
export { formatBeijingDateTime } from '@pms/shared-types';

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

export const ACTIVE_STATUSES: string[] = [...BOARD_COLUMNS.filter((s) => s !== 'pending_accept'), WorkOrderStatus.DISPATCHED];

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
  // 无偏移旧墙钟也按北京时间比较；显式offset保留原时间点和毫秒。
  const raw = iso.trim();
  const localClock = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw);
  const d = dayjs(localClock ? raw.replace(' ', 'T') + '+08:00' : raw);
  const today = formatBeijingDateTime(new Date(), 'YYYY-MM-DD');
  const dueDay = formatBeijingDateTime(iso, 'YYYY-MM-DD');
  if (d.isBefore(dayjs())) return `${formatBeijingDateTime(iso, 'MM-DD HH:mm')} · 已超时`;
  if (dueDay === today) return `今天 ${formatBeijingDateTime(iso, 'HH:mm')}`;
  if (dueDay === dayjs(today).add(1, 'day').format('YYYY-MM-DD')) return `明天 ${formatBeijingDateTime(iso, 'HH:mm')}`;
  return formatBeijingDateTime(iso, 'MM-DD HH:mm');
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

const PAY_LABELS: Record<string, string> = {
  cash: '现金', wechat: '微信', wechatpay: '微信', wx: '微信',
  alipay: '支付宝', ali: '支付宝',
  bank: '银行转账', transfer: '银行转账', remittance: '银行转账',
  card: '刷卡', pos: '刷卡', cheque: '支票', check: '支票',
  other: '其他', misc: '其他', none: '—',
};

/** 收款方式 → 中文；已经是中文的原样返回，认不出的英文码一律「其他」，不把内部码露给前台 */
export function payLabel(v?: string | null): string {
  const k = (v ?? '').trim();
  if (!k) return '—';
  if (/[\u4e00-\u9fa5]/.test(k)) return k;
  const hit = PAY_LABELS[k.toLowerCase().replace(/[\s_-]/g, '')];
  return hit ?? '其他';
}
