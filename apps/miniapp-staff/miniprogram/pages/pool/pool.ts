import { repairs } from '@pms/api-client';
import {
  createHoldToTalk,
  speechErrorTip,
  withOrderLabels,
  type HoldToTalk,
} from '@pms/miniapp-ui';
import {
  compareWorkOrderRoutePriority,
  WorkOrderStatus,
  type TechnicianOption,
  type WorkOrderListItem,
} from '@pms/shared-types';
import { isActiveOrder } from '../../utils/order-status';
import { getSession } from '../../utils/session';
import {
  cachedPoolMode,
  readCachedAccess,
  setTabBadge,
  setTabBarHidden,
  syncTabBar,
  takePoolTabTapped,
} from '../../utils/tabbar';
import { askOrderSubscribe, topUpQuietly } from '../../utils/unread';
import { refreshTabBadges } from '../../utils/badges';

/** 派单备注也允许按住说话；插件不可用时隐藏语音入口，手工输入照常可用。 */
let speechManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  speechManager = requirePlugin('WechatSI').getRecordRecognitionManager();
} catch {
  speechManager = null;
}
let assignSpeechHold: HoldToTalk | null = null;

function appendSpeech(existing: string, spoken: string): string {
  const before = existing.trim().replace(/[，,；;。]+$/, '');
  const after = spoken.trim();
  if (!before) return after;
  if (!after || before.includes(after)) return before;
  return `${before}；${after}`;
}

/**
 * 这一屏对两种人是两件事，同一份数据、两套动作：
 *   · 维修工 = 工单池：公开待接单 + 派给本人的待接单 + 等待材料
 *   · 办公室一侧 = 派单台：还没派出去的单，动作是「派单」；另外要能按状态翻、
 *     按单号/地址/描述搜，进详情看修的结果
 * 报修入口两边都留 —— 巡查发现问题顺手提单和身份无关。
 *
 * 「接单」按钮要判两层（有接单权 + claimable）：待接状态可主动认领，
 * 已进入维修中/待验收的工单不能再抢。端上原来对所有行都画按钮，
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
  /** 维修工能不能主动领这一单 */
  claimable: boolean;
  /** 办公室能不能派/改派这一单 */
  dispatchable: boolean;
  /** 按钮文案：接单 / 接回 / 派单 / 改派 */
  actionText: string;
  /** 「王师傅」/「未派单」，派单台专用 */
  assigneeText: string;
  /** 工单池里的等待材料卡默认只露出摘要，点开后再展示完整信息 */
  waitingCollapsed: boolean;

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
  /** 紧急 / 普通分组的第一张卡，用于在列表里插入组标题 */
  groupStart?: boolean;
  groupLabel?: string;
};

/** 这些状态还没开工，维修工可主动领；办公室也可派/改派 */
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
  /** 服务端的取数范围：pool 待接 / dispatch 待派 / all 全部 / reported 我提交的 / mine 派给我的 */
  scope?: 'pool' | 'dispatch' | 'all' | 'reported' | 'mine';
  /** 需要这个权限才显示这一档；不填 = 谁都能看 */
  needs?: 'myOrders';
  status?: string;
}

/**
 * 派单台的状态筛选。第一项是默认落点 —— 办公室打开这一屏，
 * 要办的事就是「把还没派的派出去」，别让他先自己挑一遍。
 */
const DISPATCH_FILTERS: PoolFilter[] = [
  { key: 'pool', label: '待派单', scope: 'dispatch' },
  { key: 'dispatched', label: '已派单', scope: 'all', status: WorkOrderStatus.DISPATCHED },
  { key: 'in_progress', label: '维修中', scope: 'all', status: WorkOrderStatus.IN_PROGRESS },
  { key: 'waiting', label: '等待材料', scope: 'all', status: WorkOrderStatus.WAITING_MATERIAL },
  { key: 'review', label: '待验收', scope: 'all', status: WorkOrderStatus.DONE_PENDING_REVIEW },
  { key: 'completed', label: '已完成', scope: 'all', status: WorkOrderStatus.COMPLETED },
  { key: 'voided', label: '已作废', scope: 'all', status: WorkOrderStatus.VOIDED },
  { key: 'all', label: '全部', scope: 'all' },
];

/**
 * 工单池（维修工）的状态筛选。scope 恒为 pool（管理处范围内的待接单），
 * 所以这里只按状态分档：
 *   新报修   = 还没指定维修工的单
 *   派给我的 = 办公室已指定本人、等待本人确认接单
 *   等待材料 = 缺料退回池子的，接回去要先确认料到没到
 * 第一项是「全部」—— 维修工进来先看有多少活，再决定挑哪种。
 */
const POOL_FILTERS: PoolFilter[] = [
  { key: 'all', label: '全部', scope: 'pool' },
  { key: 'created', label: '新报修', scope: 'pool', status: WorkOrderStatus.CREATED },
  { key: 'dispatched', label: '派给我的', scope: 'pool', status: WorkOrderStatus.DISPATCHED },
  { key: 'waiting', label: '等待材料', scope: 'pool', status: WorkOrderStatus.WAITING_MATERIAL },
  /* 「我修的」= 已经在我手上的活（scope=mine 只回 assignee_id 是本人的单，
     且默认排除待派/已派/作废）。和上面几档不是一回事：那些是「还没人认领、我可以接」，
     这一档是「已经归我了」，接单按钮不该出现在这里。
     没有「在手工单」查看权的人（只报修的保安、居委）不显示这一档。 */
  { key: 'mine', label: '我修的', scope: 'mine', needs: 'myOrders' },
];

/**
 * 「我报的」那一档的状态筛选。
 *
 * 和工单池那组不是一回事：工单池只有**没人认领**的单，所以只有两种状态可分；
 * 我报的单从提交那一刻起会走完整个流程，所以档位要盖到「已完成」——
 * 报单的人最想知道的恰恰是「修到哪一步了」（2026-09-01 要求）。
 */
const REPORTED_FILTERS: PoolFilter[] = [
  { key: 'all', label: '全部', scope: 'reported' },
  { key: 'created', label: '待派/待接', scope: 'reported', status: WorkOrderStatus.CREATED },
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
    /** 「已完结」这一档显不显示：工单池 / 派单台 / 在手工单任一格都行（范围由服务端按人收敛） */
    canSeeDone: false,
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
    urgentCount: 0,
    normalCount: 0,
    /**
     * 点了页头哪一个数字：'' 不筛 / urgent 紧急 / overdue 压 3 天以上 / normal 普通。
     * 纯前端在**当前这一屏**里筛 —— 这三个数本来就是按这一屏算的（见 load 里的注释）。
     * 数字本身不跟着筛选变：变了的话点「紧急」会把「普通」显示成 0，没人看得懂。
     */
    metricFilter: '',
    showPriorityGroups: false,
    list: [] as OrderRow[],
    loading: false,
    loaded: false,
    acceptingId: 0,
    /** 接单成功后的收纳动画：先飞向底部「在手工单」，再收起占位 */
    collectingId: 0,
    collectingIndex: -1,
    collectingHeight: 0,
    closingId: 0,
    settling: false,
    capped: false,
    emptyText: '',

    // ---- 状态筛选 + 搜索（两种模式都有，档位不同）----
    filters: POOL_FILTERS as PoolFilter[],
    filterIndex: 0,
    keyword: '',

    // ---- 派单面板 ----
    assignOpen: false,
    assignOrderId: 0,
    assignCommunityId: 0,
    /** 当前维修工候选列表是按哪个小区加载的，切换管理处后不能复用旧缓存 */
    techCommunityId: 0,
    assignOrderText: '',
    assignCurrent: '',
    techLoading: false,
    techError: '',
    technicians: [] as TechnicianOption[],
    repairTypes: [] as Array<{ repairType: string; label: string }>,
    repairTypeNames: [] as string[],
    pickedRepairType: '',
    repairTypeIndex: 0,
    techSkill: '',
    pickedTechId: 0,
    slaOptions: SLA_OPTIONS.map((item) => item.label),
    slaIndex: 3,
    assignNote: '',
    hasSpeech: !!speechManager,
    assignRecording: false,
    assignSpeechPartial: '',
    assignError: '',
    assigning: false,
  },

  /** 当前这一屏的全量行；页头数字筛选在本地做，别每点一下就重新请求 */
  allRows: [] as OrderRow[],

  onShow() {
    // 语音插件的回调是全局单例，其他页面使用后会覆盖；每次回到派单台都重新绑定到本页。
    this.bindAssignSpeech();
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
    const openOrder = takeOpenOrder();
    if (openOrder) {
      this.setData({
        mainTab: openOrder.mainTab === 'done' ? 'done' : 'pool',
        keyword: openOrder.orderNo || '',
        filterIndex: 0,
      });
    } else if (takeOpenReported()) this.setData({ mainTab: 'reported' });
    this.load();
    // 底部几格的角标一起对准（不只是「我的」的未读数）：在别的页接了单回来，数才是新的
    refreshTabBadges(this);
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
      // 底部刚点过「工单池」那一格：忘掉上次停在哪一档，回到工单池
      const tappedPoolTab = takePoolTabTapped();
      const mainTab = (() => {
        if (dispatcher) return 'pool';
        if (tappedPoolTab && session.canSeePool) return 'pool';
        if (this.data.mainTab === 'pool' && session.canSeePool) return 'pool';
        if (this.data.mainTab === 'reported' && session.canSeeMyRepairs) return 'reported';
        if (this.data.mainTab === 'done' && session.canSeeDone) return 'done';
        if (session.canSeePool) return 'pool';
        if (session.canSeeMyRepairs) return 'reported';
        if (session.canSeeDone) return 'done';
        return 'pool';
      })();

      /* 三档各有各的筛选：工单池只有未派单和等待材料；我报的要盖到「已完成」——
         报单的人最想知道的就是「修到哪一步了」；已完结那一档本身是终态，不给筛选条。
         切换时必须把选中项归零，否则从派单台的「已完成」切回工单池会落到一个
         越界的下标上，列表看着像空的。 */
      const filters = (
        mainTab === 'reported'
          ? REPORTED_FILTERS
          : dispatcher
            ? DISPATCH_FILTERS
            : POOL_FILTERS
      // 没有「在手工单」查看权的人（只报修的保安、居委）不显示「我修的」——
      // 显示了点进去也是 403，不如不给
      ).filter((item) => item.needs !== 'myOrders' || session.canSeeMyOrders);
      const modeChanged = this.data.dispatcher !== dispatcher || this.data.loaded === false;
      const filterIndex = modeChanged ? 0 : Math.min(this.data.filterIndex, filters.length - 1);
      const filter = filters[filterIndex] || filters[0];
      const keyword = this.data.keyword.trim();
      const raw = await repairs.list(
        mainTab === 'reported'
          ? { scope: 'reported', status: filter.status as any, q: keyword || undefined }
          : mainTab === 'done'
            // 已完结走 scope=done：服务端按人收敛 —— 办公室看管理处范围内全部已完结的，
            // 维修工看自己类别的（类型规则里有他 / 派给他 / 候选有他）。原来走 scope=mine
            // 只有「自己修的」，办公室连本管理处的已完工单都看不到（2026-09-04 反馈）。
            // 服务端已只回终态；端上再过一遍是兜底（判断只此一份，见 utils/order-status.ts）
            ? { scope: 'done', q: keyword || undefined }
            : {
                scope: filter.scope || (dispatcher ? 'all' : 'pool'),
                status: filter.status as any,
                q: keyword || undefined,
              },
      );
      const list = mainTab === 'done' ? raw.filter((item) => !isActiveOrder(item.status)) : raw;
      const myId = session.me?.id ?? 0;

      const rows: OrderRow[] = withOrderLabels(list).map((item) => {
        // 只有「工单池」那一档才画接单按钮：我报的 / 已完结里那张单未必轮得到我领
        const claimable =
          // 「我修的」那一档里的单已经归自己了，不再画「接单」按钮
          mainTab === 'pool' && filter.key !== 'mine' && POOL_STATUSES.indexOf(item.status) >= 0;
        const dispatchable = DISPATCHABLE_STATUSES.indexOf(item.status) >= 0;
        return {
          ...item,
          claimable,
          dispatchable,
          waitingCollapsed:
            mainTab === 'pool' && !dispatcher && item.status === WorkOrderStatus.WAITING_MATERIAL,
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
                    : item.assigneeId && item.assigneeId !== myId
                      ? '主动接单'
                    : '接单',
          assigneeText: item.assigneeName || '未派单',
          /* 网格第三格：同一格在四种场合是四个意思 —— 派单台看「在谁手上」，
             工单池 / 已完结看「找谁开门」，我报的看「派给谁了」。
             算在这里而不写进 wxml：那份模板是四处共用的，条件堆进去就没人看得懂了 */
          // 已完结也看「谁修的」：办公室翻已完工单是为了知道这单是谁做的，维修工翻同类别的单是为了找人问经验
          thirdLabel: dispatcher || mainTab === 'reported' || mainTab === 'done' ? '维修工' : '报修人',
          thirdValue:
            dispatcher || mainTab === 'reported' || mainTab === 'done'
              ? item.assigneeName || (mainTab === 'reported' ? '还没人接' : '未派单')
              : item.statReporter,
          thirdHint: dispatcher || mainTab === 'reported' || mainTab === 'done' ? '' : item.statReporterHint,
        };
      });

      // 现场处理顺序：紧急 / 超时优先；同一天再把相邻地址聚在一起，减少来回跑。
      // 服务端和端上共用同一口径，这里重排是为了防止页面加工数据时打乱顺序。
      // 「我修的」已经在自己手上，不参与「先接哪一单」的排序和分组
      const claimable = mainTab === 'pool' && filter.key !== 'mine' && (!dispatcher || filter.key === 'pool');
      if (claimable) {
        rows.sort(compareWorkOrderRoutePriority);
      }

      const showPriorityGroups = claimable;
      if (showPriorityGroups) {
        rows.forEach((row, index) => {
          const previous = rows[index - 1];
          row.groupStart = index === 0 || !!previous?.urgent !== !!row.urgent;
          row.groupLabel = row.urgent ? '紧急工单 · 先处理' : '普通工单';
        });
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
        canSeeDone: session.canSeeDone,
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
        list: this.applyMetric(rows),
        /* 页头那个红数字：压了 3 天以上的（stayTone 的 danger 档）。只在「待接 / 待派」这一档算 ——
           已完结的单再标「压了 3 天」是翻旧账，我报的那摞也不该用这个口径催自己。
           前端按当前这一屏算，不另开接口，换筛选档跟着变是对的，别理解成全局待办数。 */
        overdueCount:
          mainTab === 'pool' ? rows.filter((row) => row.stayTone === 'danger').length : 0,
        urgentCount: rows.filter((row) => row.urgent).length,
        normalCount: rows.filter((row) => !row.urgent).length,
        showPriorityGroups,
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
      (tab === 'done' && !this.data.canSeeDone)
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
    if (this.data.acceptingId || this.data.collectingId) return;
    // requestSubscribeMessage 必须由本次点击同步触发。接单请求与订阅选择并行，
    // 等原生弹窗收起后再播放动效，避免「收入在手工单」被弹窗盖住。
    const subscribePending = askOrderSubscribe().catch(() => false);
    this.setData({ acceptingId: id });
    try {
      await Promise.all([repairs.accept(id), subscribePending]);
      this.setData({ acceptingId: 0 });
      await this.playAcceptAnimation(id);
    } catch (e2: any) {
      wx.showToast({ icon: 'none', title: e2?.message || '接单失败' });
    } finally {
      if (!this.data.collectingId) this.setData({ acceptingId: 0 });
    }
  },

  /**
   * 只在服务端确认接单后播放：
   * 1) 卡片轻弹后缩小飞向底部「在手工单」；
   * 2) 原卡片高度收起；
   * 3) 下方卡片上移补位，并轻微回弹。
   */
  async playAcceptAnimation(id: number) {
    const index = this.data.list.findIndex((item) => item.id === id);
    if (index < 0) return this.load();
    const height = await new Promise<number>((resolve) => {
      this.createSelectorQuery()
        .select(`#pool-order-${id}`)
        .boundingClientRect((rect) => resolve(rect?.height || 320))
        .exec();
    });
    try {
      wx.vibrateShort({ type: 'light' });
    } catch {
      // 旧版微信不支持 type，动画照常播放
    }
    this.setData({
      collectingId: id,
      collectingIndex: index,
      collectingHeight: height,
      closingId: 0,
      settling: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 580));
    this.setData({ closingId: id, settling: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const next = this.data.list.filter((item) => item.id !== id);
    this.setData({
      list: next,
      collectingId: 0,
      collectingIndex: -1,
      collectingHeight: 0,
      closingId: 0,
      settling: false,
      overdueCount: next.filter((row) => row.stayTone === 'danger').length,
      emptyText: next.length ? this.data.emptyText : '工单池是空的，暂时没有待接的活',
    });
    if (this.data.mainTab === 'pool' && !this.data.keyword) {
      setTabBadge(this, this.data.dispatcher ? 'dispatch' : 'pool', next.length);
    }
    // 收纳落点的角标立即同步，不用等用户真的点进「在手工单」才刷新（统一入口，各格一起对准）
    refreshTabBadges(this);
    wx.showToast({ title: '已接单，正在打开在手工单', icon: 'none', duration: 900 });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await new Promise<void>((resolve) => {
      wx.switchTab({
        url: '/pages/my-orders/my-orders',
        success: () => resolve(),
        fail: () => resolve(),
      });
    });
  },

  // ---------------- 办公室：派单 ----------------

  onOpenAssign(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.list.find((item) => item.id === id);
    if (!row) return;
    this.setData({
      assignOpen: true,
      assignOrderId: id,
      assignCommunityId: row.communityId,
      assignOrderText: `${row.typeLabel} · ${row.summaryAddress || '未填地址'}`,
      assignCurrent: row.assigneeId ? `当前：${row.assigneeText}` : '',
      pickedRepairType: row.repairType || row.skill || '',
      pickedTechId: row.assigneeId || 0,
      assignNote: '',
      assignError: '',
      slaIndex: 3,
    });
    // 胶囊 tabBar 会盖住面板底部的「确认派单」，且它不吃页面里的 z-index —— 开着面板就藏起来
    setTabBarHidden(this, true);
    this.loadRepairTypes(row.repairType || row.skill || '');
  },

  onCloseAssign() {
    if (this.data.assignRecording) assignSpeechHold?.release();
    this.setData({ assignOpen: false, assignRecording: false, assignSpeechPartial: '' });
    setTabBarHidden(this, false);
  },

  bindAssignSpeech() {
    if (!speechManager) return;
    assignSpeechHold = createHoldToTalk(speechManager);
    speechManager.onStart = () => {
      this.setData({ assignRecording: true, assignSpeechPartial: '' });
      assignSpeechHold?.started();
    };
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ assignSpeechPartial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      assignSpeechHold?.ended();
      const text = (res.result || this.data.assignSpeechPartial || '').trim();
      this.setData({ assignRecording: false, assignSpeechPartial: '' });
      if (text) this.setData({ assignNote: appendSpeech(this.data.assignNote, text) });
    };
    speechManager.onError = (err: { msg?: string; retcode?: number }) => {
      assignSpeechHold?.ended();
      this.setData({ assignRecording: false, assignSpeechPartial: '' });
      speechErrorTip(err).then((tip) => wx.showToast({ icon: 'none', title: tip }));
    };
  },

  onAssignSpeechStart() {
    this.setData({ assignError: '' });
    assignSpeechHold?.press();
  },

  onAssignSpeechEnd() {
    assignSpeechHold?.release();
  },

  /** 面板内容区滚动时不要把底下的列表也带着滚 */
  noop() {},

  async loadRepairTypes(currentType = '') {
    try {
      const list = await repairs.types(this.data.assignCommunityId || undefined);
      const foundIndex = list.findIndex((item) => item.repairType === currentType);
      const index = foundIndex >= 0 ? foundIndex : 0;
      const pickedRepairType = list[index]?.repairType || '';
      this.setData({
        repairTypes: list,
        repairTypeNames: list.map((item) => item.label),
        repairTypeIndex: index,
        pickedRepairType,
        pickedTechId: 0,
      });
      this.loadTechnicians(true);
    } catch (e: any) {
      this.setData({ assignError: e?.message || '工单类型加载失败' });
    }
  },

  onPickRepairType(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    const pickedRepairType = this.data.repairTypes[index]?.repairType || '';
    this.setData({ repairTypeIndex: index, pickedRepairType, pickedTechId: 0, assignError: '' });
    this.loadTechnicians(true);
  },

  async loadTechnicians(force = false) {
    const communityId = this.data.assignCommunityId || 0;
    const skill = this.data.pickedRepairType;
    if (
      this.data.technicians.length &&
      this.data.techCommunityId === communityId &&
      this.data.techSkill === skill &&
      !force
    ) return;
    this.setData({ techLoading: true, techError: '' });
    try {
      const list = await repairs.technicians(communityId || undefined, skill || undefined);
      // 手上活少的排前面：派单台上最该先看见「谁现在闲着」
      list.sort((a, b) => a.openCount - b.openCount || a.id - b.id);
      this.setData({ technicians: list, techCommunityId: communityId, techSkill: skill });
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
    if (!this.data.pickedRepairType) {
      return this.setData({ assignError: '请先选择工单类型' });
    }
    if (!this.data.pickedTechId) {
      return this.setData({ assignError: '先选一位维修工' });
    }
    const hours = SLA_OPTIONS[this.data.slaIndex]?.hours || 0;
    this.setData({ assigning: true, assignError: '' });
    try {
      await repairs.assign(this.data.assignOrderId, {
        assigneeId: this.data.pickedTechId,
        skill: this.data.pickedRepairType,
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
    if (this.data.collectingId) return;
    // 勾过「总是保持以上选择」的人，在这里静默把订阅额度补满 ——
    // 微信要求 requestSubscribeMessage 由点击触发，而「点开一张工单」是维修工
    // 一天里发生最多次的点击。没勾过的人这里什么都不会发生（见 topUpQuietly）
    topUpQuietly();
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },

  /** 等待材料默认折叠：第一次点只展开，不直接跳详情，避免误触。 */
  onExpandWaiting(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const index = this.data.list.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.setData({ [`list[${index}].waitingCollapsed`]: false });
  },

  /** 展开后可随时收回摘要态，且不触发整卡的详情跳转。 */
  onCollapseWaiting(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const index = this.data.list.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.setData({ [`list[${index}].waitingCollapsed`]: true });
  },

  /** 按页头选中的那个数字筛当前这一屏；没选就原样返回 */
  applyMetric(rows: OrderRow[]): OrderRow[] {
    this.allRows = rows;
    const metric = this.data.metricFilter;
    if (metric === 'urgent') return rows.filter((row) => row.urgent);
    if (metric === 'overdue') return rows.filter((row) => row.stayTone === 'danger');
    if (metric === 'normal') return rows.filter((row) => !row.urgent);
    return rows;
  },

  /**
   * 点页头的数字就按它筛，再点一次取消。
   *
   * 不重新请求：这三个数就是从当前这一屏算出来的，本地筛既快又不会和数字对不上。
   */
  onTapMetric(e: WechatMiniprogram.BaseEvent) {
    const metric = String(e.currentTarget.dataset.metric || '');
    const next = this.data.metricFilter === metric ? '' : metric;
    this.setData({ metricFilter: next }, () => {
      this.setData({ list: this.applyMetric(this.allRows) });
    });
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

function takeOpenOrder(): { mainTab?: string; orderNo?: string } | null {
  try {
    const raw = wx.getStorageSync('pms.staff.open_order');
    if (!raw) return null;
    wx.removeStorageSync('pms.staff.open_order');
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
