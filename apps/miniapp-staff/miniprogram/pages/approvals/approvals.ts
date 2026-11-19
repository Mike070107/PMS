import { approvals, familyCars, maintenance, purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import { getSession } from '../../utils/session';
import { cachedApprovalMode, rememberApprovalMode, setTabBadge, syncTabBar } from '../../utils/tabbar';
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

/** 亲情车待审卡片。图片地址是服务端下发的相对路径，小程序要拼成绝对地址才能显示 */
interface FamilyFile extends familyCars.FamilyCarFile {
  /** 图片的绝对地址；PDF 留空，只显示文件名 */
  photo: string;
}

interface FamilyRow extends Omit<familyCars.FamilyCarDetail, 'files'> {
  files: FamilyFile[];
  roomText: string;
  carOwnerText: string;
  garageText: string;
  termText: string;
  termReason: string;
  createdAtText: string;
  photos: string[];
}

function toFamilyRow(item: familyCars.FamilyCarDetail): FamilyRow {
  const app = getApp<{ baseURL?: string }>();
  const base = String(app?.baseURL || '');
  // baseURL 形如 https://prsznh.cn/api/v1，去掉 /api/v1 就是站点根
  const origin = base.replace(/\/api\/v1\/?$/, '');
  const absolute = (url: string) => (!url || /^https?:\/\//.test(url) ? url : `${origin}${url}`);
  const files: FamilyFile[] = (item.files || []).map((file) => ({
    ...file,
    fileUrl: absolute(file.fileUrl),
    photo: String(file.contentType || '').startsWith('image/') ? absolute(file.fileUrl) : '',
  }));
  return {
    ...item,
    files,
    roomText: `${item.lane} 弄 ${item.buildingNo} 号 ${item.roomNo} 室`,
    carOwnerText: [item.carOwnerName || '车主待填', item.relation].filter(Boolean).join(' · '),
    termText: item.registrationTerm?.mode === 'dates'
      ? `${item.registrationTerm.startDate} 至 ${item.registrationTerm.endDate}（自定义日期）`
      : `${item.registrationTerm?.months ?? 12}个月（允许生效日起算）`,
    termReason: item.registrationTerm?.mode === 'dates' ? item.registrationTerm.reason : '',
    garageText: (item.garages || []).map((key) => ({ phase1: '一期停车库', phase2: '二期地面车库', main: '二期大车库', civil: '二期人防车库' } as Record<string, string>)[key] || key).join('、'),
    createdAtText: formatDateTimeCn(item.createdAt),
    photos: files.map((file) => file.photo).filter(Boolean),
  };
}

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
  _loadSerial: 0,
  data: {
    centerTab: 'pending' as 'pending' | 'done',
    category: 'all' as approvals.Category | 'all',
    keyword: '',
    categories: [] as approvals.CenterResponse['categories'],
    centerTabs: { pending: 0, done: 0 },
    centerRows: [] as approvals.CenterRow[],
    genericRows: [] as any[],
    allCount: 0, centerTotal: 0, centerPage: 1, centerHasMore: false,
    loadingCenter: false, centerError: '', centerBusyKey: '',
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    mode: 'approvals' as 'approvals' | 'maintenance',
    /** 审批页里再分两摊：采购申请 / 亲情车。只有一摊权限的人不显示切换 */
    section: 'purchase' as 'purchase' | 'family',
    canApproveFamilyCar: false,
    familyList: [] as FamilyRow[],
    familyEmpty: false,
    familyBusyId: 0,
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
    /** 空态单独存布尔：wxml 里 !数组.length 在开发者工具 3.17 编译下不可靠（2026-09-05 实测） */
    summaryEmpty: false,
    reviewEmpty: false,
    selectedMap: {} as Record<number, boolean>,
    selectedCount: 0,
    summarizing: false,
  },

  /** 固定本次入栈的应用模式，避免审批/养护共用缓存影响返回后的页面。 */
  _entryMode: '' as '' | 'approvals' | 'maintenance',

  onLoad(options: Record<string, string | undefined>) {
    this._entryMode = options.mode === 'maintenance' ? 'maintenance' : 'approvals';
    rememberApprovalMode(this._entryMode);
    if (options.section === 'family') this.setData({ category: 'family' });
    else if (options.category) this.setData({ category: options.category as approvals.Category });
    wx.setNavigationBarTitle({ title: this._entryMode === 'maintenance' ? '养护单' : '审批中心' });
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

  async load(append = false) {
    const serial = (this._loadSerial || 0) + 1;
    this._loadSerial = serial;
    this.setData({ loadingCenter: true, centerError: '' });
    try {
      const session = await getSession(this);
      const requestedMode = this._entryMode || cachedApprovalMode();
      const canUseMaintenance = session.canInspectMaintenance || session.canSignMaintenance;
      const mode = requestedMode === 'maintenance' && canUseMaintenance ? 'maintenance' : 'approvals';
      this.setData({ mode, canInspectMaintenance: session.canInspectMaintenance, canSignMaintenance: session.canSignMaintenance });
      syncTabBar(this, mode === 'maintenance' ? 'more' : 'approvals');
      wx.setNavigationBarTitle({ title: mode === 'maintenance' ? '养护单' : '审批中心' });
      if (mode === 'maintenance') {
        const rows = await maintenance.signTasks();
        if (serial !== this._loadSerial) return;
        this.setData({ maintenanceList: rows.map(item => ({ ...item, createdAtText: formatDateTimeCn(item.createdAt), amountText: yuan(item.totalCents) })), loaded: true });
        setTabBadge(this, 'maintenance', rows.length);
        return;
      }
      const response = await approvals.list({ tab: this.data.centerTab, category: this.data.category, q: this.data.keyword, page: append ? this.data.centerPage + 1 : 1 });
      if (serial !== this._loadSerial) return;
      const rows = append ? [...this.data.centerRows, ...response.rows] : response.rows;
      const isPending = this.data.centerTab === 'pending';
      const reviewRows = isPending ? rows.filter(r => r.category === 'purchase').map(r => toRow(r.detail as PurchaseRequestView)) : [];
      const summaryRows = isPending ? rows.filter(r => r.category === 'summary').map(r => toRow(r.detail as PurchaseRequestView)) : [];
      const selectedMap: Record<number, boolean> = {};
      if (isPending) for (const r of summaryRows) if (this.data.selectedMap[r.id]) selectedMap[r.id] = true;
      const labels = Object.fromEntries(response.categories.map(c => [c.key, c.label]));
      const genericRows = rows.map(r => {
        const detail = (r.detail || {}) as Record<string, any>;
        const origin = String(getApp<{ baseURL?: string }>()?.baseURL || '').replace(/\/api\/v1\/?$/, '');
        const files = (detail.files || []).map((f: any) => ({ ...f, photo: String(f.contentType || '').startsWith('image/'), url: /^https?:\/\//.test(f.fileUrl || '') ? f.fileUrl : `${origin}${f.fileUrl || ''}` }));
        return { ...r, label: labels[r.category] || r.category, atText: formatDateTimeCn(r.at), lines: detail.lines || [detail.ownerName, detail.contactName || detail.carOwnerName, detail.contactPhone || detail.carOwnerPhone, detail.relation, (detail.garages || []).join('、')].filter(Boolean).join(' · '), files, photos: files.filter((f: any) => String(f.contentType).startsWith('image/')).map((f: any) => f.url), actionable: ['transfer', 'business', 'vehicle', 'familyOffice'].includes(r.category) };
      });
      this.setData({
        centerRows: rows, genericRows: isPending ? genericRows.filter(r => !['purchase', 'summary', 'family'].includes(r.category)) : genericRows,
        categories: response.categories, centerTabs: response.tabs, allCount: response.allCount,
        centerPage: response.page, centerHasMore: response.hasMore, centerTotal: response.total,
        list: isPending ? reviewRows : [], summaryList: isPending ? summaryRows : [],
        familyList: isPending ? rows.filter(r => r.category === 'family').map(r => toFamilyRow(r.detail as familyCars.FamilyCarDetail)) : [],
        canApprove: response.categories.some(c => c.key === 'purchase'),
        canSummarize: response.categories.some(c => c.key === 'summary'),
        canApproveFamilyCar: response.categories.some(c => c.key === 'family'),
        selectedMap, selectedCount: Object.keys(selectedMap).length, loaded: true,
      });
      setTabBadge(this, 'approvals', response.tabs.pending);
    } catch (e: any) {
      if (serial === this._loadSerial) this.setData({ loaded: true, centerError: e?.message || '加载失败，请重试' });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      if (serial === this._loadSerial) this.setData({ loadingCenter: false });
    }
  },

  onCenterTab(e: WechatMiniprogram.BaseEvent) {
    const tab = e.currentTarget.dataset.tab === 'done' ? 'done' : 'pending';
    if (tab === this.data.centerTab) return;
    this.setData({ centerTab: tab, centerRows: [], genericRows: [], list: [], familyList: [], summaryList: [], selectedMap: {}, selectedCount: 0 });
    this.load();
  },
  onCenterCategory(e: WechatMiniprogram.BaseEvent) {
    this.setData({ category: e.currentTarget.dataset.category || 'all', centerRows: [], genericRows: [], list: [], familyList: [], summaryList: [], selectedMap: {}, selectedCount: 0 });
    this.load();
  },
  onSearchInput(e: WechatMiniprogram.Input) { this.setData({ keyword: e.detail.value }); },
  onSearchCenter() { this.load(); },
  onLoadMoreCenter() { if (!this.data.loadingCenter && this.data.centerHasMore) this.load(true); },
  onRetryCenter() { this.load(); },
  onOpenCenterDetail(e: WechatMiniprogram.BaseEvent) {
    const { id, category } = e.currentTarget.dataset;
    if (category === 'stocktake') wx.navigateTo({ url: `/pages/stocktake-review/stocktake-review?id=${id}` });
    if (category === 'maintenance') wx.navigateTo({ url: `/pages/maintenance-sign/maintenance-sign?id=${id}` });
    if (category === 'purchase' || category === 'summary') wx.navigateTo({ url: `/pages/purchase-request/purchase-request?id=${id}` });
  },
  async onCenterDecision(e: WechatMiniprogram.BaseEvent) {
    const { id, category, approved } = e.currentTarget.dataset;
    const key = `${category}:${id}`;
    if (this.data.centerBusyKey) return;
    this.setData({ centerBusyKey: key });
    try {
      const approve = approved === true || approved === 'true';
      const response = await wx.showModal({
        title: approve ? '确认审批通过？' : '填写退回原因',
        content: approve && category === 'transfer' ? '通过后立即扣减发货仓库存并进入在途，接收仓需另行确认收货。' : approve ? '请确认已核对单据和附件。' : '',
        editable: !approve, placeholderText: '请填写原因（必填）', confirmText: approve ? '确认通过' : '确认退回',
      });
      if (!response.confirm) return;
      const note = String(response.content || '').trim();
      if (!approve && !note) { wx.showToast({ icon: 'none', title: '请填写退回原因' }); return; }
      await approvals.decide(category, Number(id), approve, note);
      wx.showToast({ title: approve ? '已通过' : '已退回' });
      await this.load();
      refreshTabBadges(this);
    } catch (err: any) { wx.showToast({ icon: 'none', title: err?.message || '操作失败' }); }
    finally { this.setData({ centerBusyKey: '' }); }
  },
  async onOpenApprovalFile(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    if (!url) return;
    try {
      const download = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url, success: resolve, fail: reject }));
      if (download.statusCode !== 200) throw new Error('资料下载失败');
      await wx.openDocument({ filePath: download.tempFilePath, showMenu: true });
    } catch (err: any) { wx.showToast({ icon: 'none', title: err?.message || '资料打开失败' }); }
  },

  onSwitchSection(e: WechatMiniprogram.BaseEvent) {
    const section = e.currentTarget.dataset.section === 'family' ? 'family' : 'purchase';
    this.setData({ section });
    wx.setNavigationBarTitle({ title: '审批中心' });
  },

  onPreviewFamilyPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({ current: url || urls[0], urls });
  },

  /** 经理通过：按申请期限由服务端推进，未来起始日仍需等待。 */
  async onApproveFamily(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const plate = String(e.currentTarget.dataset.plate || '');
    if (!id || this.data.familyBusyId) return;
    // Lock before opening the native dialog as well as during the API request.
    this.setData({ familyBusyId: id });
    try {
      const row = this.data.familyList.find(item => item.id === id);
      const res = await wx.showModal({
        title: `通过 ${plate} 的亲情车？`,
        content: `申请期限：${row?.termText || '12个月'}。${row?.termReason ? `自定义原因：${row.termReason}。` : ''}按审批期限办理；未来起始日需等待。`,
        // wx.showModal button text allows at most four characters.
        confirmText: '确认通过',
      });
      if (!res.confirm) return;
      await familyCars.managerReview(id, 'approve');
      wx.showToast({ title: '已通过，按期办理' });
      await this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    } finally {
      this.setData({ familyBusyId: 0 });
    }
  },

  /** 退回办公室：资料不清楚时用，办公室可以要求业主补资料或重新提交 */
  async onReturnFamily(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const plate = String(e.currentTarget.dataset.plate || '');
    if (!id || this.data.familyBusyId) return;
    this.setData({ familyBusyId: id });
    try {
    const res = await wx.showModal({
      title: `退回 ${plate}？`,
      editable: true,
      placeholderText: '请填写退回原因（必填），办公室会看到',
      confirmText: '确认退回',
    });
    if (!res.confirm) return;
    const reason = (res.content || '').trim();
    if (!reason) return wx.showToast({ icon: 'none', title: '请填写退回原因' });
      await familyCars.managerReview(id, 'return', reason);
      wx.showToast({ title: '已退回办公室' });
      await this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    } finally {
      this.setData({ familyBusyId: 0 });
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

  /** 只合并不提交：合成一张后仍在待汇总，办公室可以在后台改名称 / 型号 / 照片再提交 */
  async onMergeSummary() {
    const requestIds = Object.keys(this.data.selectedMap).map(Number).filter(Boolean);
    if (requestIds.length < 2) return wx.showToast({ icon: 'none', title: '至少勾选两张才能合并' });
    const res = await wx.showModal({
      title: `把 ${requestIds.length} 张合并成一张？`,
      content: '合并后仍在待汇总，可以继续勾选并入或提交；名称、型号、照片在管理后台改。',
      confirmText: '合并',
    });
    if (!res.confirm) return;
    this.setData({ summarizing: true });
    try {
      const merged = await purchases.merge({ requestIds });
      wx.showToast({ title: `已合并成 ${merged.requestNo}`, icon: 'none' });
      this.setData({ selectedMap: {}, selectedCount: 0 });
      await this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '合并失败' });
    } finally {
      this.setData({ summarizing: false });
    }
  },

  /** 把勾选的几张合并成一张提交经理；不同管理处的服务端会拦（同 Web） */
  async onSubmitSummary() {
    const requestIds = Object.keys(this.data.selectedMap).map(Number).filter(Boolean);
    if (!requestIds.length) return wx.showToast({ icon: 'none', title: '先勾选要提交的申请' });
    const nextLabel = this.data.summaryList.find((row) => this.data.selectedMap[row.id])?.nextStepLabel || '物业经理审批';
    const res = await wx.showModal({
      title: requestIds.length > 1 ? `合并 ${requestIds.length} 张申请，提交到「${nextLabel}」？` : `提交到「${nextLabel}」？`,
      content: requestIds.length > 1 ? '合并后每行仍保留来源工单，审批人可以单项驳回。' : '',
      confirmText: '提交',
    });
    if (!res.confirm) return;
    this.setData({ summarizing: true });
    try {
      const saved = await purchases.submitToManager({ requestIds });
      wx.showToast({ title: requestIds.length > 1 ? `已合并为 ${saved.requestNo}` : '已提交', icon: 'none' });
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

  /** 申请单详情页：看全部照片、改名称 / 型号 / 备注 / 数量、补图，再提交（2026-09-06 Mike） */
  onOpenDetail(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: `/pages/purchase-request/purchase-request?id=${id}` });
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
      if (this.data.list.find(row => row.id === id)?.status === PurchaseRequestStatus.PURCHASER_REVIEW) {
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
    if (!id || this.data.busyId) return;
    this.setData({ busyId: id });
    try {
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
    this.setData({ busyId: id });
    try {
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
