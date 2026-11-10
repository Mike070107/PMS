/** P2-E 收款汇总表 / 票据情况统计常量与纯函数。 */

export const TICKET_STATUSES = ['all', 'issued', 'pre_issue', 'voided', 'written_off'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const UNRECORDED_LABEL = '未记录';

/** 收款方式归一：空/空白 → 未记录；保留原始中文名。 */
export function normalizeMethodLabel(method?: string | null): string {
  const value = (method ?? '').trim();
  return value || UNRECORDED_LABEL;
}

/** 收款人归一：空/空白 → 未记录。 */
export function normalizeCashierLabel(cashier?: string | null): string {
  const value = (cashier ?? '').trim();
  return value || UNRECORDED_LABEL;
}
