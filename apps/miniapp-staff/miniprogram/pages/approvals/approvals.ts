import { auth, purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import { rememberRole, setTabBadge, syncTabBar } from '../../utils/tabbar';
import {
  PENDING_STATUS_BY_ROLE,
  PURCHASE_STATUS_LABELS,
  PurchaseRequestStatus,
  UserRole,
  type PurchaseRequestView,
} from '@pms/shared-types';

interface ApprovalRow extends PurchaseRequestView {
  statusLabel: string;
  amountText: string;
  itemsText: string;
  createdAtText: string;
}

const yuan = (cents: number) => `¥${((cents || 0) / 100).toFixed(2)}`;

function toRow(item: PurchaseRequestView): ApprovalRow {
  return {
    ...item,
    statusLabel: PURCHASE_STATUS_LABELS[item.status] || item.status,
    amountText: yuan(item.estTotalCents),
    itemsText: (item.items || []).map((i) => `${i.name} ×${i.qty}${i.unit || ''}`).join('、'),
    createdAtText: formatDateTimeCn(item.createdAt),
  };
}

Page({
  data: {
    canApprove: false,
    isPurchaserStage: false,
    roleHint: '',
    list: [] as ApprovalRow[],
    loaded: false,
    busyId: 0,
  },

  onShow() {
    syncTabBar(this, 'approvals');
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const me = await auth.me();
      rememberRole(this, me.role);
      const pendingStatus = PENDING_STATUS_BY_ROLE[me.role];
      // 只有经理/采购/管理员有审批动作；维修工、办公室看不到审批按钮
      const canApprove =
        me.role === UserRole.MANAGER ||
        me.role === UserRole.PURCHASER ||
        me.role === UserRole.ADMIN;

      if (!canApprove) {
        const hintByRole: Partial<Record<UserRole, string>> = {
          [UserRole.TECHNICIAN]:
            '维修工没有采购审批权限。缺料请在工单详情里提报，由办公室汇总后进入审批流程。',
          [UserRole.OFFICE]:
            '办公室负责汇总采购申请并提交给物业经理，这一步请在管理后台操作。',
        };
        this.setData({
          canApprove: false,
          roleHint: hintByRole[me.role] || '当前角色没有采购审批权限',
          list: [],
          loaded: true,
        });
        setTabBadge(this, 'approvals', 0);
        return;
      }

      // 管理员没有专属待办状态，默认看经理待审的那批
      const status = pendingStatus ?? PurchaseRequestStatus.MANAGER_REVIEW;
      const list = await purchases.listRequests({ status });
      this.setData({
        canApprove: true,
        isPurchaserStage: status === PurchaseRequestStatus.PURCHASER_REVIEW,
        roleHint: PURCHASE_STATUS_LABELS[status],
        list: list.map(toRow),
        loaded: true,
      });
      setTabBadge(this, 'approvals', list.length);
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  async onApprove(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (this.data.busyId) return;
    this.setData({ busyId: id });
    try {
      if (this.data.isPurchaserStage) {
        await purchases.purchaserApprove(id);
      } else {
        await purchases.managerApprove(id);
      }
      wx.showToast({ title: '已通过' });
      this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    } finally {
      this.setData({ busyId: 0 });
    }
  },

  async onReject(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const res = await wx.showModal({
      title: '驳回采购申请',
      editable: true,
      placeholderText: '请填写驳回原因（必填）',
      confirmText: '确认驳回',
    });
    if (!res.confirm) return;
    const reason = (res.content || '').trim();
    if (!reason) {
      return wx.showToast({ icon: 'none', title: '请填写驳回原因' });
    }
    this.setData({ busyId: id });
    try {
      await purchases.reject(id, { reason });
      wx.showToast({ title: '已驳回' });
      this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    } finally {
      this.setData({ busyId: 0 });
    }
  },
});
