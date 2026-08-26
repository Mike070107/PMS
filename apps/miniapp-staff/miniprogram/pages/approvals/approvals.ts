import { purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import { getSession } from '../../utils/session';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';
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
      // 身份和权限都走共用会话（一次登录只打一遍 /auth/me），别每页各调各的
      const session = await getSession(this);
      const role = session.role as UserRole;
      const me = { role };
      const pendingStatus = PENDING_STATUS_BY_ROLE[me.role];
      // 审批链按业务身份把关（经理/采购/管理员），角色矩阵可以在此之上再收紧：
      // 同是经理，也允许只让其中一部分人真的能批
      const canApprove = session.canApprove;
      const identityAllows =
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
          // 身份本来该能批、只是角色里没勾，就把话说明白 —— 否则经理会以为系统坏了
          roleHint: identityAllows
            ? '你的角色暂时没有审批权限。请管理员在管理后台「业务角色」页，把你的角色在员工端小程序那张表里「采购审批」这一行的「审批」勾上；改完下拉刷新即可。'
            : hintByRole[me.role] || '当前角色没有采购审批权限',
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
