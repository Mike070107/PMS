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
    /**
     * 办公室汇总（2026-09-05 从 Web 搬到小程序）：有「材料与库存·操作」权的人看到待汇总的申请，
     * 勾选几张合并成一张提交经理。selectedMap 用对象存，wxml 里没法调 indexOf。
     */
    canSummarize: false,
    stage: 'review' as 'review' | 'summary',
    summaryList: [] as ApprovalRow[],
    selectedMap: {} as Record<number, boolean>,
    selectedCount: 0,
    summarizing: false,
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

      // 办公室汇总用的是「材料与库存·操作」这一格 —— 和 Web 上合并提交是同一个权限
      const canSummarize = session.canEditMaterials;
      if (!session.canApprove && !canSummarize) {
        this.setData({
          canApprove: false,
          canSummarize: false,
          // 说清楚去哪儿开，不然人对着一句「没权限」不知道找谁
          roleHint:
            '你的角色没有采购审批权限。请管理员在管理后台「业务角色」页，' +
            '把你的角色在「邻修小程序页面权限」里勾上「采购审批（经理这一步）」' +
            '或「采购审批（采购这一步）」的「批 / 驳回」；办公室汇总要勾「材料与库存」的「操作」。' +
            '改完在这一页下拉刷新即可。',
          list: [],
          summaryList: [],
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
      const [reviewList, summaryList] = await Promise.all([
        session.canApprove ? purchases.listRequests({ status }) : Promise.resolve([]),
        canSummarize
          ? purchases.listRequests({ status: PurchaseRequestStatus.OFFICE_REVIEW })
          : Promise.resolve([]),
      ]);
      // 人切到哪一档就留在哪一档；只有一档权限的直接落到那档
      const stage: 'review' | 'summary' =
        this.data.stage === 'summary' && canSummarize
          ? 'summary'
          : session.canApprove
            ? 'review'
            : 'summary';
      const summaryRows = summaryList.map(toRow);
      const selectedMap: Record<number, boolean> = {};
      for (const row of summaryRows) if (this.data.selectedMap[row.id]) selectedMap[row.id] = true;
      this.setData({
        canApprove: session.canApprove,
        canSummarize,
        stage,
        isPurchaserStage: status === PurchaseRequestStatus.PURCHASER_REVIEW,
        roleHint: PURCHASE_STATUS_LABELS[status],
        list: reviewList.map(toRow),
        summaryList: summaryRows,
        selectedMap,
        selectedCount: Object.keys(selectedMap).length,
        loaded: true,
      });
      // 角标 = 轮到我审的 + 等我汇总的
      setTabBadge(this, 'approvals', reviewList.length + summaryList.length);
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onSwitchStage(e: WechatMiniprogram.BaseEvent) {
    const stage = e.currentTarget.dataset.stage === 'summary' ? 'summary' : 'review';
    this.setData({ stage });
  },

  /** 勾选 / 取消勾选一张待汇总的申请 */
  onToggleSelect(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const selectedMap = { ...this.data.selectedMap };
    if (selectedMap[id]) delete selectedMap[id];
    else selectedMap[id] = true;
    this.setData({ selectedMap, selectedCount: Object.keys(selectedMap).length });
  },

  /** 把勾选的几张合并成一张提交经理；不同管理处的服务端会拦（同 Web） */
  async onSubmitSummary() {
    const requestIds = Object.keys(this.data.selectedMap).map(Number).filter(Boolean);
    if (!requestIds.length) return wx.showToast({ icon: 'none', title: '先勾选要提交的申请' });
    const res = await wx.showModal({
      title: requestIds.length > 1 ? `合并 ${requestIds.length} 张申请提交经理？` : '提交这张申请给经理审批？',
      content: requestIds.length > 1 ? '合并后每行仍保留来源工单，经理可以单项驳回。' : '',
      confirmText: '提交',
    });
    if (!res.confirm) return;
    this.setData({ summarizing: true });
    try {
      const saved = await purchases.submitToManager({ requestIds });
      wx.showToast({ title: requestIds.length > 1 ? `已合并为 ${saved.requestNo}` : '已提交经理', icon: 'none' });
      this.setData({ selectedMap: {}, selectedCount: 0 });
      await this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '提交失败' });
    } finally {
      this.setData({ summarizing: false });
    }
  },

  /** 明细行上的来源工单号可点：直接进那张工单看现场情况 */
  onOpenSourceOrder(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.orderId);
    if (!id) return;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },

  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    const list = urls.length ? urls : url ? [url] : [];
    if (!list.length) return;
    wx.previewImage({ current: url || list[0], urls: list });
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
