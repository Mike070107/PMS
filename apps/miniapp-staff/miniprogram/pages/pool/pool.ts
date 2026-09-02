import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import {
  WorkOrderStatus,
  type TechnicianOption,
  type WorkOrderListItem,
} from '@pms/shared-types';
import { isActiveOrder } from '../../utils/order-status';
import { getSession } from '../../utils/session';
import { cachedPoolMode, readCachedAccess, setTabBadge, setTabBarHidden, syncTabBar } from '../../utils/tabbar';
import { askOrderSubscribe, refreshUnread, topUpQuietly } from '../../utils/unread';

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

  /* ---- 卡片数据网格用的四个短值（data-first-ui）：由 withOrderLabels 一并算好 ----
     在手工单页用的是同一份，改口径去 packages/miniapp-ui/src/format.ts，别在页面里再算一遍。
     stayBadge / reporterText 那两个整句仍留着给详情页用。 */
  /** 「已等」/「用时」—— 第一格的标签，完结了就换说法 */
  statStayLabel: string;
  /** 「8天」/「今天」—— 网格里放大到 44rpx 的那个数 */
  statStay: string;
  /** 「王女士」—— 报修人姓名，不带身份后缀 */
  statReporter: string;
  /** 「业主」「保安代报」—— 身份，压在姓名下面当说明 */
  statReporterHint: string;
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

interface PoolFilter {
  key: string;
  label: string;
  /** 服务端的取数范围：pool 未认领的 / all 全部 / reported 我提交的 */
  scope?: 'pool' | 'all' | 'reported';
  status?: string;
}

/**
 * 派单台的状态筛选。第一项是默认落点 —— 办公室打开这一屏，
 * 要办的事就是「把还没派的派出去」，别让他先自己挑一遍。
 */
const DISPATCH_FILTERS: PoolFilter[] = [
  { key: 'pool', label: '待派单', scope: 'pool' },
  { key: 'dispatched', label: '已派单', scope: 'all', status: WorkOrderStatus.DISPATCHED },
  { key: 'in_progress', label: '维修中', scope: 'all', status: WorkOrderStatus.IN_PROGRESS },
  { key: 'waiting', label: '等待材料', scope: 'all', status: WorkOrderStatus.WAITING_MATERIAL },
  { key: 'review', label: '待验收', scope: 'all', status: WorkOrderStatus.DONE_PENDING_REVIEW },
  { key: 'completed', label: '已完成', scope: 'all', status: WorkOrderStatus.COMPLETED },
  { key: 'all', label: '全部', scope: 'all' },
];

/**
 * 工单池（维修工）的状态筛选。scope 恒为 pool（只有没人认领的单），
 * 所以这里只按状态分档，档位就是 POOL_STATUSES 那三种：
 *   新报修   = 还没派给任何人，谁都能领
 *   已派单   = 派下来了但没指定到人
 *   等待材料 = 缺料退回池子的，接回去要先确认料到没到
 * 第一项是「全部」—— 维修工进来先看有多少活，再决定挑哪种。
 */
const POOL_FILTERS: PoolFilter[] = [
  { key: 'all', label: '全部', scope: 'pool' },
  { key: 'created', label: '新报修', scope: 'pool', status: WorkOrderStatus.CREATED },
  { key: 'dispatched', label: '已派单', scope: 'pool', status: WorkOrderStatus.DISPATCHED },
  { key: 'waiting', label: '等待材料', scope: 'pool', status: WorkOrderStatus.WAITING_MATERIAL },
];

/**
 * 「我报的」那一档的状态筛选。
 *
 * 和工单池那组不是一回事：工单池只有**没人认领**的单，所以只有三种状态可分；
 * 我报的单从提交那一刻起会走完整个流程，所以档位要盖到「已完成」——
 * 报单的人最想知道的恰恰是「修到哪一步了」（2026-09-01 要求）。
 */
const REPORTED_FILTERS: PoolFilter[] = [
  { key: 'all', label: '全部', scope: 'reported' },
  { key: 'created', label: '待派单', scope: 'reported', status: WorkOrderStatus.CREATED },
  { key: 'dispatched', label: '已派单', scope: 'reported', status: WorkOrderStatus.DISPATCHED },
  { key: 'in_progress', label: '维修中', scope: 'reported', status: WorkOrderStatus.IN_PROGRESS },
  { key: 'waiting', label: '等待材料', scope: 'reported', status: WorkOrderStatus.WAITING_MATERIAL },
  { key: 'review', label: '待验收', scope: 'reported', status: WorkOrderStatus.DONE_PENDING_REVIEW },
  { key: 'completed', label: '已完成', scope: 'reported', status: WorkOrderStatus.COMPLETED },
];

/**
 * onShow 时先点亮哪一格（session 还没回来，只能看缓存）。
 *
 * 不能直接用 cachedPoolMode()：它没缓存时默认 'dispatch'，而纯维修工的 tabBar 上
 * 根本没有派单台那一格，setActive('dispatch') 会把 selectedKey 指到一个不存在的 key ——
 * 结果是**一格都不高亮**，网络慢或 load 失败时就一直全灰。
 * 所以先按权限缓存排除掉看不见的那一格，口径和 load() 里定 mode 的一致。
 */
function initialTabKey(): 'pool' | 'dispatch' {
  const { pages } = readCachedAccess();
  if (pages) {
    const poolVisible = !!(pages['app:pool'] || pages['app:my-repairs']);
    if (!pages['app:dispatch']) return 'pool';
    if (!poolVisible) return 'dispatch';
  }
  return cachedPoolMode();
}

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
    screenTitle: '工单池',
    canSeePool: false,
    canSeeMyRepairs: false,
    canSeeMyOrders: false,
    canDispatch: false,
    /** 报修入口：由角色矩阵的「报修」那一格决定 */
    canReport: false,
    /** 接单权：和派单同一个勾选（工单池那一格的「接单 / 派单」） */
    canAccept: false,
    /**
     * 这一屏看哪一批单：工单池（待接的）/ 我报的 / 已完结。
     * 只有工单池这一侧有这三档 —— 派单台自己就有 7 档状态筛选，再叠一层人分不清点哪排。
     * 「我报的」「已完结」原来在「在手工单」页，2026-08-31 搬过来，那页只留手上要干的活。
     */
    mainTab: 'pool',
    leadText: '待接单',
    /** 页头红数字：这一屏里压了 3 天以上的单数，0 就不显示那一格 */
    overdueCount: 0,
    list: [] as OrderRow[],
    loading: false,
    loaded: false,
    acceptingId: 0,
    capped: false,
    emptyText: '',

    // ---- 状态筛选 + 搜索（两种模式都有，档位不同）----
    filters: POOL_FILTERS as PoolFilter[],
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
    /**
     * 先按缓存点亮对应的那一格。
     *
     * 这里原来写死 syncTabBar(this, 'pool')：工单池和派单台在 tabBar 上是**两格**
     * （key 'pool' / 'dispatch'），却共用这一个页面，于是点「派单台」进来，
     * 页面确实是派单台，底部高亮的却是「工单池」，派单台那一格始终是灰的。
     * 真正的模式要等 session 回来才能定（两格都没权限时按仅有的那一格），
     * 所以 load() 里还会再同步一次；这里先按缓存点，避免高亮闪一下再跳。
     */
    syncTabBar(this, initialTabKey());
    // 从「我的 → 我的报修」进来的：直接落在「我报的」那一档（tabBar 页 switchTab
    // 带不了参数，所以用一次性标记传话，见 me.ts 的 onOpenReported）
    if (takeOpenReported()) this.setData({ mainTab: 'reported' });
    this.load();
    refreshUnread(this);
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
      /**
       * 只报修的人（保安、居委会…）在「工单池」那一档什么都看不到 —— 直接把他放在
       * 「我报的」这一档，别让人一进来就对着一片空白猜是不是坏了。
       *
       * 原来是 switchTab 去「在手工单」页，那页 2026-08-31 只剩手上要干的活了，
       * 他手上一张单都没有，跳过去还是一片空白 —— 这三档就是为这种人准备的。
       */
      // 这一屏有两种模式：派单台（把活派给别人）和工单池（自己领活）。
      // 两格都有权限时看 tabBar 点的是哪一格；只有一格就按那一格
      const mode = (() => {
        const poolVisible = session.canSeePool || session.canSeeMyRepairs;
        if (!session.canSeeDispatch) return 'pool';
        if (!poolVisible) return 'dispatch';
        return cachedPoolMode();
      })();
      const dispatcher = mode === 'dispatch';

      // 三档各自有独立权限。当前档被管理员取消后，刷新必须落到仍有权限的第一档，
      // 不能继续请求旧 scope（服务端也会按 scope 拒绝）。
      const mainTab = (() => {
        if (dispatcher) return 'pool';
        if (this.data.mainTab === 'pool' && session.canSeePool) return 'pool';
        if (this.data.mainTab === 'reported' && session.canSeeMyRepairs) return 'reported';
        if (this.data.mainTab === 'done' && session.canSeeMyOrders) return 'done';
        if (session.canSeePool) return 'pool';
        if (session.canSeeMyRepairs) return 'reported';
        if (session.canSeeMyOrders) return 'done';
        return 'pool';
      })();

      /* 三档各有各的筛选：工单池只有未认领的三种状态；我报的要盖到「已完成」——
         报单的人最想知道的就是「修到哪一步了」；已完结那一档本身是终态，不给筛选条。
         切换时必须把选中项归零，否则从派单台的「已完成」切回工单池会落到一个
         越界的下标上，列表看着像空的。 */
      const filters =
        mainTab === 'reported'
          ? REPORTED_FILTERS
          : dispatcher
            ? DISPATCH_FILTERS
            : POOL_FILTERS;
      const modeChanged = this.data.dispatcher !== dispatcher || this.data.loaded === false;
      const filterIndex = modeChanged ? 0 : Math.min(this.data.filterIndex, filters.length - 1);
      const filter = filters[filterIndex] || filters[0];
      const keyword = this.data.keyword.trim();
      const raw = await repairs.list(
        mainTab === 'reported'
          ? { scope: 'reported', status: filter.status as any, q: keyword || undefined }
          : mainTab === 'done'
            // 已完结走 scope=mine：这是「我经手的单」里已经结束的那些，和原来在手工单页那一档同口径。
            // 服务端不按「完结与否」筛，拿回来再过一遍（判断只此一份，见 utils/order-status.ts）
            ? { scope: 'mine', q: keyword || undefined }
            : {
                scope: filter.scope || (dispatcher ? 'all' : 'pool'),
                status: filter.status as any,
                q: keyword || undefined,
              },
      );
      const list = mainTab === 'done' ? raw.filter((item) => !isActiveOrder(item.status)) : raw;

      const rows: OrderRow[] = withOrderLabels(list).map((item) => {
        // 只有「工单池」那一档才画接单按钮：我报的 / 已完结里那张单未必轮得到我领
        const claimable =
          mainTab === 'pool' && !item.assigneeId && POOL_STATUSES.indexOf(item.status) >= 0;
        const dispatchable = DISPATCHABLE_STATUSES.indexOf(item.status) >= 0;
        return {
          ...item,
          claimable,
          dispatchable,
          actionText:
            mainTab === 'reported'
              ? '看进度'
              : mainTab === 'done'
                ? '查看详情'
                : dispatcher
                  ? item.assigneeId
                    ? '改派'
                    : '派单'
                  : item.status === WorkOrderStatus.WAITING_MATERIAL
                    ? '接回'
                    : '接单',
          assigneeText: item.assigneeName || '未派单',
          /* 网格第三格：同一格在四种场合是四个意思 —— 派单台看「在谁手上」，
             工单池 / 已完结看「找谁开门」，我报的看「派给谁了」。
             算在这里而不写进 wxml：那份模板是四处共用的，条件堆进去就没人看得懂了 */
          thirdLabel: dispatcher || mainTab === 'reported' ? '维修工' : '报修人',
          thirdValue:
            dispatcher || mainTab === 'reported'
              ? item.assigneeName || (mainTab === 'reported' ? '还没人接' : '未派单')
              : item.statReporter,
          thirdHint: dispatcher || mainTab === 'reported' ? '' : item.statReporterHint,
        };
      });

      // 待派单/待接单这一档按压得久的排前面；按状态翻历史时保持服务端的时间倒序
      if (mainTab === 'pool' && (!dispatcher || filter.key === 'pool')) {
        rows.sort((a, b) => b.stayDays - a.stayDays || b.id - a.id);
      }

      this.setData({
        dispatcher,
        screenTitle:
          dispatcher
            ? '派单台'
            : !session.canSeePool && session.canSeeMyRepairs
              ? '我的报修'
              : '工单池',
        canSeePool: session.canSeePool,
        canSeeMyRepairs: session.canSeeMyRepairs,
        canSeeMyOrders: session.canSeeMyOrders,
        canDispatch: session.canDispatch,
        canReport: session.canReport,
        canAccept: session.canAccept,
        mainTab,
        filters,
        filterIndex,
        // 页头那句话说的是「这一屏在办什么事」
        leadText:
          mainTab === 'reported'
            // 翻到具体某一档就报档名，和工单池同一个做法：页头那个数说的是「眼前这批」
            ? (filter.key === 'all' ? '我报的' : filter.label)
            : mainTab === 'done'
              ? '已完结'
              : filter.key === (dispatcher ? 'pool' : 'all')
                ? dispatcher
                  ? '待派单'
                  : '待接单'
                : filter.label,
        list: rows,
        /* 页头那个红数字：压了 3 天以上的（stayTone 的 danger 档）。只在「待接 / 待派」这一档算 ——
           已完结的单再标「压了 3 天」是翻旧账，我报的那摞也不该用这个口径催自己。
           前端按当前这一屏算，不另开接口，换筛选档跟着变是对的，别理解成全局待办数。 */
        overdueCount:
          mainTab === 'pool' ? rows.filter((row) => row.stayTone === 'danger').length : 0,
        loaded: true,
        capped: rows.length >= PAGE_CAP,
        /* 空态要说清「空在哪一层」：搜的没有 / 这一档没有 / 真的没活。
           三种情况给同一句话，人会以为是坏了或者搜索没生效 */
        emptyText: keyword
          ? '没搜到匹配的工单，换个单号、地址或描述试试'
          : mainTab === 'reported'
            ? filter.key === 'all'
              ? '你还没有替住户或巡查报过修'
              : `你报的单里没有「${filter.label}」的`
            : mainTab === 'done'
              ? '还没有已完结的工单'
              : filter.key !== (dispatcher ? 'pool' : 'all')
                ? `「${filter.label}」这一档里没有工单`
                : dispatcher
                  ? '没有待派单的工单，都派出去了'
                  : '工单池是空的，暂时没有待接的活',
      });
      // 顶栏标题跟着身份走：办公室进来看到的不是「工单池」而是「派单台」。
      // 标题写在 pool.json 里是静态的，只能在这儿按身份改一次
      wx.setNavigationBarTitle({
        title:
          dispatcher
            ? '派单台'
            : !session.canSeePool && session.canSeeMyRepairs
              ? '我的报修'
              : '工单池',
      });
      // 模式定下来了，把底部高亮同步到真正的那一格（onShow 里先按缓存点过一次）
      syncTabBar(this, dispatcher ? 'dispatch' : 'pool');
      /**
       * 角标固定表示「有几件事要办」= 默认档、没搜索时的条数。
       * 翻筛选或搜索时不改它，否则角标跟着筛选跳，就不再是「待办数」了。
       * key 必须跟着模式走：挂错格子的话，派单台的待办数会显示在工单池那一格上。
       */
      const isDefaultView =
        mainTab === 'pool' && !keyword && filter.key === (dispatcher ? 'pool' : 'all');
      if (isDefaultView) setTabBadge(this, dispatcher ? 'dispatch' : 'pool', rows.length);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 切「工单池 / 我报的 / 已完结」。换的是一批数据，状态筛选和搜索词都归零 */
  onSwitchMainTab(e: WechatMiniprogram.BaseEvent) {
    const tab = String(e.currentTarget.dataset.tab || 'pool') as 'pool' | 'reported' | 'done';
    if (
      (tab === 'pool' && !this.data.canSeePool) ||
      (tab === 'reported' && !this.data.canSeeMyRepairs) ||
      (tab === 'done' && !this.data.canSeeMyOrders)
    ) return;
    if (tab === this.data.mainTab) return;
    this.setData({ mainTab: tab, filterIndex: 0, keyword: '' }, () => this.load());
  },

  // ---------------- 筛选与搜索（工单池 / 派单台共用，档位不同）----------------

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
      // 顺手补一次「新工单提醒」的订阅额度：微信是同意一次推一条，
      // 刚接完单是最愿意点「允许」的时刻（一进小程序就弹，多数人会下意识拒绝，
      // 而「拒绝并不再询问」是持久的，弹错一次就再没机会了）
      askOrderSubscribe();
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
    // 胶囊 tabBar 会盖住面板底部的「确认派单」，且它不吃页面里的 z-index —— 开着面板就藏起来
    setTabBarHidden(this, true);
    this.loadTechnicians();
  },

  onCloseAssign() {
    this.setData({ assignOpen: false });
    setTabBarHidden(this, false);
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
      setTabBarHidden(this, false);
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

  /**
   * 点卡片上的报修照片 = 看大图（catchtap 已经拦住冒泡，不会顺带进详情）。
   * urls 用这张卡自己的那几张，别把整屏的图都串进去 —— 左右滑会滑到别人家的照片。
   */
  onPreviewShot(e: WechatMiniprogram.BaseEvent) {
    const urls = (e.currentTarget.dataset.urls || []) as string[];
    const current = e.currentTarget.dataset.url as string;
    if (!urls.length || !current) return;
    wx.previewImage({ current, urls });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    // 勾过「总是保持以上选择」的人，在这里静默把订阅额度补满 ——
    // 微信要求 requestSubscribeMessage 由点击触发，而「点开一张工单」是维修工
    // 一天里发生最多次的点击。没勾过的人这里什么都不会发生（见 topUpQuietly）
    topUpQuietly();
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});

/** 「我的」页点「我的报修」时写下的一次性标记：进来直接切到「我报的」那一档 */
const OPEN_REPORTED_KEY = 'pms.staff.open_reported';

function takeOpenReported(): boolean {
  try {
    if (wx.getStorageSync(OPEN_REPORTED_KEY) !== '1') return false;
    wx.removeStorageSync(OPEN_REPORTED_KEY);
    return true;
  } catch {
    return false;
  }
}
