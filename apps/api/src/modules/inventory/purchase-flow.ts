import { PurchaseRequestStatus } from '../../common/enums';
import type { PurchaseApprovalSetting } from '../settings/settings.constants';

/**
 * 采购审批链（2026-09-05 Mike：经理审批、办公室审批、采购部审批要能分别开关）。
 *
 * 链路固定顺序：办公室 → 物业经理 → 采购部 → 通过（可下单）。每一环能关；
 * 经理、采购两环还能按预估金额跳过（低于阈值不用批）。关掉 / 跳过的环节直接越过，
 * 不留空审批人。所有「下一步是什么」的判断都走这里，服务层和界面不各算一套。
 */
export type PurchaseStage = 'create' | 'office' | 'manager' | 'purchaser';

const below = (estTotalCents: number, yuan: number) =>
  Number(yuan) > 0 && estTotalCents < Math.round(Number(yuan) * 100);

/** 从 from 这一环往后，下一个还开着的环节对应的状态 */
export function nextPurchaseStatus(
  setting: PurchaseApprovalSetting,
  from: PurchaseStage,
  estTotalCents: number,
): PurchaseRequestStatus {
  const managerOn = setting.manager && !below(estTotalCents, setting.skipManagerBelowYuan);
  const purchaserOn = setting.purchaser && !below(estTotalCents, setting.skipPurchaserBelowYuan);
  if (from === 'create' && setting.office !== 'off') return PurchaseRequestStatus.OFFICE_REVIEW;
  if ((from === 'create' || from === 'office') && managerOn) return PurchaseRequestStatus.MANAGER_REVIEW;
  if (from !== 'purchaser' && purchaserOn) return PurchaseRequestStatus.PURCHASER_REVIEW;
  return PurchaseRequestStatus.APPROVED;
}

/** 给办公室看的「提交后去哪」 */
export function nextStepLabel(
  setting: PurchaseApprovalSetting,
  from: PurchaseStage,
  estTotalCents: number,
): string {
  const next = nextPurchaseStatus(setting, from, estTotalCents);
  if (next === PurchaseRequestStatus.OFFICE_REVIEW) return setting.office === 'approve' ? '办公室审批' : '办公室汇总';
  if (next === PurchaseRequestStatus.MANAGER_REVIEW) return '物业经理审批';
  if (next === PurchaseRequestStatus.PURCHASER_REVIEW) return '采购部审批';
  return '直接通过，待下单';
}

/** 某个状态下该通知谁：权限格 + 通知事件 + 标题后缀 */
export function pendingStepFor(status: PurchaseRequestStatus): {
  pageKey: string;
  action: 'view' | 'edit';
  eventKey: string;
  title: string;
} | null {
  switch (status) {
    case PurchaseRequestStatus.OFFICE_REVIEW:
      return { pageKey: 'app:dispatch', action: 'edit', eventKey: 'purchase_pending_office', title: '缺料申请待汇总' };
    case PurchaseRequestStatus.MANAGER_REVIEW:
      return { pageKey: 'app:approve-manager', action: 'edit', eventKey: 'purchase_pending_manager', title: '待物业经理审批' };
    case PurchaseRequestStatus.PURCHASER_REVIEW:
      return { pageKey: 'app:approve-purchaser', action: 'edit', eventKey: 'purchase_pending_purchaser', title: '待采购部审批' };
    case PurchaseRequestStatus.APPROVED:
      return { pageKey: 'app:approve-purchaser', action: 'edit', eventKey: 'purchase_approved', title: '已按审批链自动通过，待下单' };
    default:
      return null;
  }
}

export interface PurchaseStepView {
  key: 'office' | 'manager' | 'purchaser' | 'order';
  label: string;
  /** done 已完成 / current 当前环节 / pending 还没到 / skipped 关掉或金额低于阈值跳过 */
  state: 'done' | 'current' | 'pending' | 'skipped';
  by?: string | null;
  at?: string | null;
  /** 为什么跳过、或「待转采购单」这类补充 */
  note?: string;
}

/** 一张申请单的审批链视图：界面直接画，不再各端自己推 */
export function purchaseSteps(
  setting: PurchaseApprovalSetting,
  req: {
    status: PurchaseRequestStatus;
    estTotalCents: number;
    officeReviewedAt?: Date | string | null;
    managerAt?: Date | string | null;
    purchaserAt?: Date | string | null;
  },
  names: { office?: string | null; manager?: string | null; purchaser?: string | null } = {},
): PurchaseStepView[] {
  const iso = (v?: Date | string | null) => (v ? new Date(v).toISOString() : null);
  const order = [
    PurchaseRequestStatus.OFFICE_REVIEW,
    PurchaseRequestStatus.MANAGER_REVIEW,
    PurchaseRequestStatus.PURCHASER_REVIEW,
    PurchaseRequestStatus.APPROVED,
    PurchaseRequestStatus.DONE,
  ];
  const rank = order.indexOf(req.status);
  const passed = (stageStatus: PurchaseRequestStatus) =>
    rank > order.indexOf(stageStatus) || req.status === PurchaseRequestStatus.REJECTED || req.status === PurchaseRequestStatus.MERGED;
  const yuan = (v: number) => `¥${Number(v).toFixed(2)}`;

  const office: PurchaseStepView = { key: 'office', label: setting.office === 'approve' ? '办公室审批' : '办公室汇总', state: 'pending' };
  if (setting.office === 'off') Object.assign(office, { state: 'skipped', note: '未启用' });
  else if (req.status === PurchaseRequestStatus.OFFICE_REVIEW) office.state = 'current';
  else if (passed(PurchaseRequestStatus.OFFICE_REVIEW)) Object.assign(office, { state: 'done', by: names.office ?? null, at: iso(req.officeReviewedAt) });
  else office.state = 'pending';

  const manager: PurchaseStepView = { key: 'manager', label: '物业经理审批', state: 'pending' };
  if (!setting.manager) Object.assign(manager, { state: 'skipped', note: '未启用' });
  else if (below(req.estTotalCents, setting.skipManagerBelowYuan))
    Object.assign(manager, { state: 'skipped', note: `金额低于 ${yuan(setting.skipManagerBelowYuan)}，跳过` });
  else if (req.managerAt) Object.assign(manager, { state: 'done', by: names.manager ?? null, at: iso(req.managerAt) });
  else if (req.status === PurchaseRequestStatus.MANAGER_REVIEW) manager.state = 'current';
  else manager.state = 'pending';

  const purchaser: PurchaseStepView = { key: 'purchaser', label: '采购部审批', state: 'pending' };
  if (!setting.purchaser) Object.assign(purchaser, { state: 'skipped', note: '未启用' });
  else if (below(req.estTotalCents, setting.skipPurchaserBelowYuan))
    Object.assign(purchaser, { state: 'skipped', note: `金额低于 ${yuan(setting.skipPurchaserBelowYuan)}，跳过` });
  else if (req.purchaserAt) Object.assign(purchaser, { state: 'done', by: names.purchaser ?? null, at: iso(req.purchaserAt) });
  else if (req.status === PurchaseRequestStatus.PURCHASER_REVIEW) purchaser.state = 'current';
  else purchaser.state = 'pending';

  const orderStep: PurchaseStepView = { key: 'order', label: '采购下单', state: 'pending' };
  if (req.status === PurchaseRequestStatus.DONE) Object.assign(orderStep, { state: 'done', note: '已转采购单' });
  else if (req.status === PurchaseRequestStatus.APPROVED) Object.assign(orderStep, { state: 'current', note: '待转采购单' });
  else orderStep.state = 'pending';

  return [office, manager, purchaser, orderStep] as PurchaseStepView[];
}
