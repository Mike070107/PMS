import { WorkOrderStatus } from '../../common/enums';

/**
 * 接单方式判定（纯函数，便于单测）：
 *  - claim：从工单池认领（待派单 / 等材料，或尚未指定负责人），负责人改成操作人本人；
 *  - accept：被派人本人确认接单；
 *  - accept_on_behalf：已派给别的维修工，办公室/管理员（有派单权限）代其确认接单，负责人不变。
 * 没有派单权限的人不能动派给别人的单。
 */
export type AcceptMode = 'claim' | 'accept' | 'accept_on_behalf';

export function decideAcceptMode(input: {
  status: WorkOrderStatus;
  assigneeId: number | null;
  userId: number;
  canDispatch: boolean;
}): { mode: AcceptMode } | { error: string } {
  const { status, assigneeId, userId, canDispatch } = input;
  if (assigneeId === userId) return { mode: 'accept' };
  if (status === WorkOrderStatus.DISPATCHED && assigneeId) {
    return canDispatch ? { mode: 'accept_on_behalf' } : { error: '工单已派给其他维修工' };
  }
  return { mode: 'claim' };
}

/** 代办留痕：操作人不是负责人时，时间轴备注前加「办公室代填」，审计能分清是谁做的 */
export function proxyNote(note: string | null | undefined, operatorId: number, assigneeId: number | null): string | null {
  const clean = note?.trim() || null;
  if (assigneeId == null || assigneeId === operatorId) return clean;
  return clean ? `办公室代填；${clean}` : '办公室代填';
}
