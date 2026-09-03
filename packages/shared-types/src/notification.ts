/**
 * 消息中心的展示分类。
 *
 * 后端的 eventKey 是业务事件，不适合直接给用户看；三个端若各自判断，
 * 同一条消息就可能在网页端叫“库存”、在小程序又叫“审批”。因此统一放在这里。
 */
export type NotificationCategory = 'work_order' | 'approval' | 'inventory' | 'system' | 'other';
export type NotificationPriority = 'action' | 'important' | 'normal';

export interface NotificationPresentation {
  category: NotificationCategory;
  categoryLabel: string;
  /** 给小程序 CSS 和 Web Tag 共用的稳定色调 key */
  categoryTone: 'blue' | 'purple' | 'cyan' | 'red' | 'gray';
  priority: NotificationPriority;
  priorityLabel: '待处理' | '重要提醒' | '普通通知';
  important: boolean;
}

const CATEGORY_META: Record<NotificationCategory, Pick<NotificationPresentation, 'categoryLabel' | 'categoryTone'>> = {
  work_order: { categoryLabel: '工单', categoryTone: 'blue' },
  approval: { categoryLabel: '审批', categoryTone: 'purple' },
  inventory: { categoryLabel: '库存', categoryTone: 'cyan' },
  system: { categoryLabel: '系统', categoryTone: 'red' },
  other: { categoryLabel: '通知', categoryTone: 'gray' },
};

const EVENT_CATEGORY: Record<string, NotificationCategory> = {
  order_dispatched: 'work_order',
  order_review: 'work_order',
  order_pool_unassigned: 'work_order',
  order_pool_new: 'work_order',
  order_transfer_requested: 'work_order',
  order_assigned: 'work_order',
  order_urge_repair: 'work_order',
  order_accept_overdue: 'work_order',
  order_accept_overdue_office: 'work_order',
  order_urged: 'work_order',
  order_urged_escalated: 'work_order',

  purchase_pending_office: 'approval',
  purchase_pending_manager: 'approval',
  purchase_pending_purchaser: 'approval',
  transfer_pending_review: 'approval',

  transfer_approved: 'inventory',
  transfer_rejected: 'inventory',
  transfer_received: 'inventory',
  transfer_received_variance: 'inventory',
  receipt_qty_variance: 'inventory',

  system_alert: 'system',
  user_feedback: 'system',
};

/** 点进去后有一件明确的事需要当前收件人完成。 */
const ACTION_EVENTS = new Set([
  'order_review',
  'order_pool_unassigned',
  'order_pool_new',
  'order_transfer_requested',
  'order_assigned',
  'order_urge_repair',
  'order_accept_overdue',
  'order_accept_overdue_office',
  'order_urged',
  'order_urged_escalated',
  'purchase_pending_office',
  'purchase_pending_manager',
  'purchase_pending_purchaser',
  'transfer_pending_review',
  'transfer_approved',
  'transfer_received_variance',
  'receipt_qty_variance',
  'system_alert',
  'user_feedback',
]);

/** 需要留意，但没有一个当场必须点掉的审批/接单动作。 */
const IMPORTANT_EVENTS = new Set([
  'transfer_rejected',
]);

function inferCategory(eventKey: string): NotificationCategory {
  if (/^order_/.test(eventKey)) return 'work_order';
  if (/^(purchase_.*pending|.*_review)/.test(eventKey)) return 'approval';
  if (/^(purchase_|transfer_|receipt_|stock_|inventory_)/.test(eventKey)) return 'inventory';
  if (/^(system_|user_feedback|alert_)/.test(eventKey)) return 'system';
  return 'other';
}

/**
 * 已知事件精确归类；新事件暂未加入映射时，依据 eventKey 前缀安全降级。
 * 未知事件不会被自动标成“待处理”，避免制造虚假紧急感。
 */
export function classifyNotification(eventKey?: string | null): NotificationPresentation {
  const key = String(eventKey || '').trim();
  const category = EVENT_CATEGORY[key] || inferCategory(key);
  const priority: NotificationPriority = ACTION_EVENTS.has(key)
    ? 'action'
    : IMPORTANT_EVENTS.has(key)
      ? 'important'
      : 'normal';
  const priorityLabel = priority === 'action'
    ? '待处理'
    : priority === 'important'
      ? '重要提醒'
      : '普通通知';

  return {
    category,
    ...CATEGORY_META[category],
    priority,
    priorityLabel,
    important: priority !== 'normal',
  };
}

