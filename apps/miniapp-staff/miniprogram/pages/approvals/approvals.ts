import { maintenance, purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import { getSession } from '../../utils/session';
import { cachedApprovalMode, setTabBadge, syncTabBar } from '../../utils/tabbar';
import { refreshTabBadges } from '../../utils/badges';
import {
  PURCHASE_STATUS_LABELS,
  PurchaseRequestStatus,
  UserRole,
  type PurchaseRequestView,
  type PurchaseRequestItem,
} from '@pms/shared-types';
import { guideHandlers } from '../../utils/guide';

interface ApprovalItem extends PurchaseRequestItem {
  lineId: string;
  sourceText: string;
  amountText: string;
}

interface ApprovalRow extends PurchaseRequestView {
  statusLabel: string;
  amountText: string;
  itemsText: string;
  createdAtText: string;
  /** 「来自工单 XXX」显示的文字：工单号 + 申请人，不是工单的数据库 id */
  sourceText: string;
  applicantText: string;
  reviewItems: ApprovalItem[];
}

const yuan = (cents: number) => `¥${((cents || 0) / 100).toFixed(2)}`;

interface MaintenanceRow extends maintenance.MaintenanceListItem {
  createdAtText: string;
  amountText: string;
  slotLabel?: string;
}

function toRow(item: PurchaseRequestView): ApprovalRow {
  return {
    ...item,
    statusLabel: PURCHASE_STATUS_LABELS[item.status] || item.status,
    amountText: yuan(item.estTotalCents),
    itemsText: (item.items || []).map((i) => `${i.name} ×${i.qty}${i.unit || ''}`).join('、'),
    createdAtText: formatDateTimeCn(item.createdAt),
    // 工单号和申请人姓名由服务端下发；以前这里写的是「#19」，审批的人根本认不出是哪张单
    sourceText: item.sourceWorkOrderNos?.length
      ? item.sourceWorkOrderNos.join('、')
      : item.workOrderId
        ? item.workOrderNo || '未知工单'
        : '',
    applicantText: item.applicantName || '未知申请人',
    reviewItems: (item.items || []).map((line, index) => ({
      ...line,
      lineId: line.lineId || `${item.id}-${index + 1}`,
      sourceText: line.sourceWorkOrderNo || line.sourceRequestNo || '手工申请',
      amountText:
        line.estUnitCostCents != null
          ? yuan(line.estUnitCostCents * line.qty)
          : '未估价',
    })),
  };
}

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    mode: 'approvals' as 'approvals' | 'maintenance',
    canApprove: false,
    canInspectMaintenance: false,
    canSignMaintenance: false,
    isPurchaserStage: false,
    roleHint: '',
    list: [] as ApprovalRow[],
    loaded: false,
    busyId: 0,
    maintenanceList: [] as MaintenanceRow[],
  },

  onShow() {
    this.syncGuide();
    this.load();
    // 底部其它几格的角标一起对准（这一页自己那格由 load 按列表条数设）
    refreshTabBadges(this);
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      // 权限走共用会话（一次登录只打一遍 /auth/me），别每页各调各的
      const session = await getSession(this);
      const requestedMode = cachedApprovalMode();
      const canUseMaintenance = session.canInspectMaintenance || session.canSignMaintenance;
      const mode = requestedMode === 'maintenance' && canUseMaintenance
        ? 'maintenance'
        : requestedMode === 'approvals' && session.canApprove
          ? 'approvals'
          : canUseMaintenance ? 'maintenance' : 'approvals';
      this.setData({ mode, canInspectMaintenance: session.canInspectMaintenance, canSignMaintenance: session.canSignMaintenance });
      syncTabBar(this, mode === 'maintenance' ? 'maintenance' : 'approvals');

      if (mode === 'maintenance') {
        if (!canUseMaintenance) {
          this.setData({ maintenanceList: [], loaded: true });
          setTabBadge(this, 'maintenance', 0);
          return;
        }
        const list = await maintenance.signTasks();
        const maintenanceList = list.map((item) => ({
          ...item,
          createdAtText: formatDateTimeCn(item.createdAt),
          amountText: yuan(item.totalCents),
        }));
        this.setData({ maintenanceList, loaded: true });
        setTabBadge(this, 'maintenance', maintenanceList.length);
        return;
      }

      if (!session.canApprove) {
        this.setData({
          canApprove: false,
          // 说清楚去哪儿开，不然人对着一句「没权限」不知道找谁
          roleHint:
            '你的角色没有采购审批权限。请管理员在管理后台「业务角色」页，' +
            '把你的角色在「邻修小程序页面权限」里勾上「采购审批（经理这一步）」' +
            '或「采购审批（采购这一步）」的「批 / 驳回」；改完在这一页下拉刷新即可。',
          list: [],
          loaded: true,
        });
        setTabBadge(this, 'approvals', 0);
        return;
      }

      // 两步审批各看各的那批单。两步都有权限时先看经理那一步
      // （采购申请必须先过经理，先处理前一步才不会积压）
      const status = session.canApproveAsManager
        ? PurchaseRequestStatus.MANAGER_REVIEW
        : PurchaseRequestStatus.PURCHASER_REVIEW;
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

  async onOpenMaintenance(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id || this.data.busyId) return;
    this.setData({ busyId: id });
    try {
      // 员工端用登录身份直接打开：不创建 30 分钟链接，任务在本人手机里一直有效。
      wx.navigateTo({ url: `/pages/maintenance-sign/maintenance-sign?id=${id}` });
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '养护单打开失败' });
    } finally { this.setData({ busyId: 0 }); }
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

  async onRejectItem(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const lineId = String(e.currentTarget.dataset.line || '');
    const name = String(e.currentTarget.dataset.name || '该明细');
    if (!id || !lineId || this.data.busyId) return;
    const res = await wx.showModal({
      title: `驳回单项：${name}`,
      content: '只驳回这一行，申请会退回办公室修改后重新提审。',
      editable: true,
      placeholderText: '请填单项驳回原因（必填）',
      confirmText: '驳回此项',
    });
    if (!res.confirm) return;
    const reason = (res.content || '').trim();
    if (!reason) return wx.showToast({ icon: 'none', title: '请填驳回原因' });
    this.setData({ busyId: id });
    try {
      await purchases.rejectItem(id, { lineId, reason });
      wx.showToast({ title: '已驳回该项' });
      this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    } finally {
      this.setData({ busyId: 0 });
    }
  },
});
