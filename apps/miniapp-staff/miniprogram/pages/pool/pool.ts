import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import {
  WorkOrderStatus,
  type TechnicianOption,
  type WorkOrderListItem,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';

/**
 * 这一屏对两种人是两件事，同一份数据、两套动作：
 *   · 维修工 = 工单池：没人认领的单，动作是「接单」
 *   · 办公室一侧 = 派单台：还没派出去的单，动作是「派单」；另外要能按状态翻、
 *     按单号/地址/描述搜，进详情看修的结果
 * 报修入口两边都留 —— 巡查发现问题顺手提单和身份无关。
 *
 * 「接单」按钮为什么要判两层（isTechnician + claimable）：后端 accept 只让维修工
 * 领未指派的单（见 acceptWorkOrder 的 claim 分支），端上原来对所有行都画按钮，
 * 于是办公室看到一屏「已派单 / 维修中」的单上全挂着接单按钮，点了必然 403。
 */

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayDays: number;
  stayText: string;
  stayTone: string;
  timeText: string;
  stayBadge: string;
  urgent: boolean;
  /** 「PVC 管 DN50 ×2 米」，等待材料的单才有 */
  missingText: string;
  /** 维修工能不能领这一单（无人认领 + 状态允许） */
  claimable: boolean;
  /** 办公室能不能派/改派这一单 */
  dispatchable: boolean;
  /** 按钮文案：接单 / 接回 / 派单 / 改派 */
  actionText: string;
  /** 「王师傅」/「未派单」，派单台专用 */
  assigneeText: string;
};

/** 未指派 + 这些状态 = 维修工可以领、办公室需要派 */
const POOL_STATUSES: string[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.WAITING_MATERIAL,
];

/** 派单/改派开放的状态：已完结（待验收/已完成/已撤单）的单不该再改派 */
const DISPATCHABLE_STATUSES: string[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
];

/**
 * 派单台的状态筛选。第一项是默认落点 —— 办公室打开这一屏，
 * 要办的事就是「把还没派的派出去」，别让他先自己挑一遍。
 */
const FILTERS: Array<{ key: string; label: string; scope?: 'pool' | 'all'; status?: string }> = [
  { key: 'pool', label: '待派单', scope: 'pool' },
  { key: 'dispatched', label: '已派单', scope: 'all', status: WorkOrderStatus.DISPATCHED },
  { key: 'in_progress', label: '维修中', scope: 'all', status: WorkOrderStatus.IN_PROGRESS },
  { key: 'waiting', label: '等待材料', scope: 'all', status: WorkOrderStatus.WAITING_MATERIAL },
  { key: 'review', label: '待验收', scope: 'all', status: WorkOrderStatus.DONE_PENDING_REVIEW },
  { key: 'completed', label: '已完成', scope: 'all', status: WorkOrderStatus.COMPLETED },
  { key: 'all', label: '全部', scope: 'all' },
];

/** 要求完成时限的可选项。派单时给几个常用档，不要让人打字 */
const SLA_OPTIONS = [
  { label: '不设时限', hours: 0 },
  { label: '4 小时内', hours: 4 },
  { label: '当天（8 小时）', hours: 8 },
  { label: '24 小时内', hours: 24 },
  { label: '3 天内', hours: 72 },
];

/** 服务端最多给 100 条，到顶了必须说出来，不然看着就是「搜索漏了」 */
const PAGE_CAP = 100;

Page({
  data: {
    /** 维修工视角 / 派单台视角，决定整屏的标题、按钮和筛选条 */
    dispatcher: false,
    canDispatch: false,
    leadText: '待接单',
    list: [] as OrderRow[],
    loading: false,
    loaded: false,
    acceptingId: 0,
    capped: false,

    // ---- 派单台 ----
    filters: FILTERS,
    filterIndex: 0,
    keyword: '',

    // ---- 派单面板 ----
    assignOpen: false,
    assignOrderId: 0,
    assignOrderText: '',
    assignCurrent: '',
    techLoading: false,
    techError: '',
    technicians: [] as TechnicianOption[],
    pickedTechId: 0,
    slaOptions: SLA_OPTIONS.map((item) => item.label),
    slaIndex: 3,
    assignNote: '',
    assignError: '',
    assigning: false,
  },

  onShow() {
    syncTabBar(this, 'pool');
    this.load();
  },

  /**
   * 下拉刷新连权限一起重新拿。
   * 后台刚给这个角色勾上「工单管理-编辑」，人回到小程序却还是没有派单按钮 ——
   * 会话里的权限是登录时那一份，不强制刷新就得杀掉小程序重进，没人猜得到。
   */
  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  async load(refreshSession = false) {
    this.setData({ loading: true });
    try {
      const session = await getSession(this, refreshSession);
      const dispatcher = session.isDispatcher;
      const filter = FILTERS[this.data.filterIndex] || FILTERS[0];
      const keyword = this.data.keyword.trim();

      const list = await repairs.list(
        dispatcher
          ? {
              scope: filter.scope || 'all',
              status: filter.status as any,
              q: keyword || undefined,
            }
          : { scope: 'pool' },
      );

      const rows: OrderRow[] = withOrderLabels(list).map((item) => {
        const claimable = !item.assigneeId && POOL_STATUSES.indexOf(item.status) >= 0;
        const dispatchable = DISPATCHABLE_STATUSES.indexOf(item.status) >= 0;
        return {
          ...item,
          claimable,
          dispatchable,
          actionText: dispatcher
            ? item.assigneeId
              ? '改派'
              : '派单'
            : item.status === WorkOrderStatus.WAITING_MATERIAL
              ? '接回'
              : '接单',
          assigneeText: item.assigneeName || '未派单',
        };
      });

      // 待派单/待接单这一档按压得久的排前面；按状态翻历史时保持服务端的时间倒序
      if (!dispatcher || filter.key === 'pool') {
        rows.sort((a, b) => b.stayDays - a.stayDays || b.id - a.id);
      }

      this.setData({
        dispatcher,
        canDispatch: session.canDispatch,
        leadText: dispatcher ? filter.label : '待接单',
        list: rows,
        loaded: true,
        capped: rows.length >= PAGE_CAP,
      });
      // 顶栏标题跟着身份走：办公室进来看到的不是「工单池」而是「派单台」。
      // 标题写在 pool.json 里是静态的，只能在这儿按身份改一次
      wx.setNavigationBarTitle({ title: dispatcher ? '派单台' : '工单池' });
      // 角标固定表示「待派单/待接单有几条」。翻到别的状态时不改它，
      // 免得角标跟着筛选条乱跳（那样它就不再是「有几件事要办」了）
      if (!dispatcher || filter.key === 'pool') setTabBadge(this, 'pool', rows.length);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // ---------------- 派单台：筛选与搜索 ----------------

  onPickFilter(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (index === this.data.filterIndex) return;
    this.setData({ filterIndex: index }, () => this.load());
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
  },

  /** 搜索走服务端（列表截断在 100 条，本地过滤会漏掉没取回来的那些） */
  onSearch() {
    this.load();
  },

  onClearKeyword() {
    if (!this.data.keyword) return;
    this.setData({ keyword: '' }, () => this.load());
  },

  // ---------------- 维修工：接单 ----------------

  async onAccept(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (this.data.acceptingId) return;
    this.setData({ acceptingId: id });
    try {
      await repairs.accept(id);
      wx.showToast({ title: '已接单，去「在手工单」' });
      this.load();
    } catch (e2: any) {
      wx.showToast({ icon: 'none', title: e2?.message || '接单失败' });
    } finally {
      this.setData({ acceptingId: 0 });
    }
  },

  // ---------------- 办公室：派单 ----------------

  onOpenAssign(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.list.find((item) => item.id === id);
    if (!row) return;
    this.setData({
      assignOpen: true,
      assignOrderId: id,
      assignOrderText: `${row.typeLabel} · ${row.summaryAddress || '未填地址'}`,
      assignCurrent: row.assigneeId ? `当前：${row.assigneeText}` : '',
      pickedTechId: row.assigneeId || 0,
      assignNote: '',
      assignError: '',
      slaIndex: 3,
    });
    this.loadTechnicians();
  },

  onCloseAssign() {
    this.setData({ assignOpen: false });
  },

  /** 面板内容区滚动时不要把底下的列表也带着滚 */
  noop() {},

  async loadTechnicians(force = false) {
    if (this.data.technicians.length && !force) return;
    this.setData({ techLoading: true, techError: '' });
    try {
      const list = await repairs.technicians();
      // 手上活少的排前面：派单台上最该先看见「谁现在闲着」
      list.sort((a, b) => a.openCount - b.openCount || a.id - b.id);
      this.setData({ technicians: list });
    } catch (e: any) {
      this.setData({ techError: e?.message || '维修工列表加载失败' });
    } finally {
      this.setData({ techLoading: false });
    }
  },

  onRetryTechnicians() {
    this.loadTechnicians(true);
  },

  onPickTech(e: WechatMiniprogram.BaseEvent) {
    this.setData({ pickedTechId: Number(e.currentTarget.dataset.id), assignError: '' });
  },

  onPickSla(e: WechatMiniprogram.PickerChange) {
    this.setData({ slaIndex: Number(e.detail.value) });
  },

  onAssignNote(e: WechatMiniprogram.Input) {
    this.setData({ assignNote: e.detail.value });
  },

  async onSubmitAssign() {
    if (!this.data.pickedTechId) {
      return this.setData({ assignError: '先选一位维修工' });
    }
    const hours = SLA_OPTIONS[this.data.slaIndex]?.hours || 0;
    this.setData({ assigning: true, assignError: '' });
    try {
      await repairs.assign(this.data.assignOrderId, {
        assigneeId: this.data.pickedTechId,
        slaHours: hours || undefined,
        note: this.data.assignNote.trim() || undefined,
      });
      this.setData({ assignOpen: false });
      wx.showToast({ title: '已派单' });
      // 派完这一单就不在「待派单」里了，重新拉一遍，别让它还留在列表上
      this.load();
      this.loadTechnicians(true);
    } catch (e: any) {
      this.setData({ assignError: e?.message || '派单失败' });
    } finally {
      this.setData({ assigning: false });
    }
  },

  // ---------------- 报修入口（两种身份都保留） ----------------

  onGoRepair() {
    wx.navigateTo({ url: '/pages/repair-create/repair-create' });
  },

  onGoQuickRepair() {
    wx.navigateTo({ url: '/pages/quick-repair/quick-repair' });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});
