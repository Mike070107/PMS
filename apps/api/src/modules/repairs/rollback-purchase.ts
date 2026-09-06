import { PurchaseRequestStatus } from '../../common/enums';

/**
 * 撤回「缺料」时，这张工单牵连的采购申请各自怎么处理（2026-09-06 Mike 定的三档）。
 *
 * 之前的规矩：申请一进经理审批、或被办公室合并进汇总表，撤回就整单拦住，提示「请先处理采购申请」。
 * 可办公室根本拆不开合并后的表 —— 要「处理」只能把整张汇总表驳回，连累别的工单。现在按阶段分：
 *   1. 还没批准（办公室汇总 / 经理审批 / 采购审批）：能撤。表里只有本工单的材料 → 整单驳回；
 *      还有别的工单的行 → 只把本工单的行划掉（单行驳回，原因写「工单撤回」），其余行照常走，
 *      当前环节的人收到一句提醒。
 *   2. 已批准 / 已转采购单：能撤，采购不动 —— 材料到货照常入库进仓；已批准待下单的给采购部提个醒。
 *   3. 已驳回 / 已合并进别的申请：不用动（合并后的那张会按第 1 条处理）。
 * 纯函数：预览和执行共用同一份判定，测试直接喂数据。
 */
export type PurchaseRollbackEffect = 'reject' | 'strip' | 'keep' | 'none';

export interface PurchaseRollbackRequestLike {
  id: number;
  requestNo: string;
  status: PurchaseRequestStatus;
  workOrderId: number | null;
  items: Array<{ lineId?: string; sourceWorkOrderId?: number | null; rejectReason?: string }> | null;
}

export interface PurchaseRollbackDecision {
  id: number;
  requestNo: string;
  status: PurchaseRequestStatus;
  effect: PurchaseRollbackEffect;
  /** 要划掉的行（只有 strip 有） */
  lineIds: string[];
  /** 这一环节的人：strip / 非办公室阶段的 reject 要通知他们 */
  notifyStage: boolean;
  /** 给人看的一句话：预览弹窗、撤回记录里都用它 */
  note: string;
}

const STAGE_PEOPLE: Partial<Record<PurchaseRequestStatus, string>> = {
  [PurchaseRequestStatus.DRAFT]: '办公室',
  [PurchaseRequestStatus.OFFICE_REVIEW]: '办公室',
  [PurchaseRequestStatus.MANAGER_REVIEW]: '物业经理',
  [PurchaseRequestStatus.PURCHASER_REVIEW]: '采购部',
};

export function planPurchaseRollback(
  workOrderId: number,
  requests: PurchaseRollbackRequestLike[],
): PurchaseRollbackDecision[] {
  return requests.map((request) => {
    const no = request.requestNo;
    const base = {
      id: request.id,
      requestNo: no,
      status: request.status,
      lineIds: [] as string[],
      notifyStage: false,
    };
    switch (request.status) {
      case PurchaseRequestStatus.MERGED:
        return { ...base, effect: 'none', note: `采购申请 ${no} 已合并进别的申请，按合并后的那张处理` };
      case PurchaseRequestStatus.REJECTED:
        return { ...base, effect: 'none', note: `采购申请 ${no} 早已驳回，不用动` };
      case PurchaseRequestStatus.DONE:
        return { ...base, effect: 'keep', note: `采购申请 ${no} 已转采购单，不受影响；材料到货后照常入库` };
      case PurchaseRequestStatus.APPROVED:
        return {
          ...base,
          effect: 'keep',
          notifyStage: true,
          note: `采购申请 ${no} 已批准待下单，不受影响；采购部会收到提醒，不再需要可在下单前处理`,
        };
      default:
        break;
    }

    // 还在审批链上：看表里本工单的行和别的工单的行各剩几行
    const lines = (request.items || []).map((item, index) => ({
      lineId: item.lineId || `${request.id}-${index + 1}`,
      mine: (item.sourceWorkOrderId ?? request.workOrderId) === workOrderId,
      active: !item.rejectReason,
    }));
    const mine = lines.filter((line) => line.mine && line.active);
    const others = lines.filter((line) => !line.mine && line.active);
    const who = STAGE_PEOPLE[request.status] ?? '审批人';
    const inOffice =
      request.status === PurchaseRequestStatus.DRAFT ||
      request.status === PurchaseRequestStatus.OFFICE_REVIEW;

    if (!mine.length) {
      return { ...base, effect: 'none', note: `采购申请 ${no} 里本工单的材料已被驳回，不用动` };
    }
    if (!others.length) {
      return {
        ...base,
        effect: 'reject',
        notifyStage: !inOffice,
        note: `采购申请 ${no} 只有本工单的材料，将整单驳回${inOffice ? '' : `，${who}会收到提醒`}`,
      };
    }
    return {
      ...base,
      effect: 'strip',
      lineIds: mine.map((line) => line.lineId),
      notifyStage: true,
      note: `采购申请 ${no} 里本工单的 ${mine.length} 行将划掉，其余 ${others.length} 行不受影响；${who}会收到提醒`,
    };
  });
}
