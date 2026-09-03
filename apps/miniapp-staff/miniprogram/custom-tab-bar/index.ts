/**
 * 自定义 tabBar。
 *
 * 为什么不用微信原生 tabBar：原生只认本地 png 图标，也没法按权限藏 tab。
 * 之前四个 tab 只有文字、当前项只靠一点点蓝，站在楼道里扫一眼分不清自己在哪一屏、
 * 哪里有活要干；维修工点「审批」进去还永远是一句「你没权限」—— 这些都是
 * 「不知道该点哪里」的具体来源。
 *
 * 现在：SVG 图标（wxss data URI，跟着主题色走）＋ 当前项加粗高亮 ＋ 未处理数量角标，
 * **哪几格可见完全由后台「业务角色」页的勾选决定**（utils/roles.ts 的 canSeeTab）。
 * 各页拿到 /auth/me 时把权限写进缓存（utils/tabbar.ts 的 rememberAccess），
 * 所以后台改完角色，用户下拉刷新一次底部就跟着变，不用杀掉小程序重进。
 */
import { canSeeTab, type TabAccess, type TabKey } from '../utils/roles';
import { readCachedAccess, rememberApprovalMode, rememberPoolMode } from '../utils/tabbar';
import { topUpQuietly } from '../utils/unread';

interface TabDef {
  key: TabKey;
  pagePath: string;
  text: string;
}

// 工单池和派单台是两格：一个是「有活我领」，一个是「有活我派给谁」。
// 同一个角色两格都勾也行（比如维修组长），底部就都显示。
const ALL_TABS: TabDef[] = [
  { key: 'dispatch', pagePath: '/pages/pool/pool?mode=dispatch', text: '派单台' },
  { key: 'pool', pagePath: '/pages/pool/pool', text: '工单池' },
  { key: 'mine', pagePath: '/pages/my-orders/my-orders', text: '在手工单' },
  { key: 'maintenance', pagePath: '/pages/approvals/approvals?mode=maintenance', text: '养护单' },
  { key: 'materials', pagePath: '/pages/inventory/inventory', text: '材料与库存' },
  { key: 'approvals', pagePath: '/pages/approvals/approvals', text: '审批' },
  { key: 'me', pagePath: '/pages/me/me', text: '我的' },
];

function visibleTabs(access: TabAccess) {
  const tabs = ALL_TABS.filter((tab) => canSeeTab(tab.key, access)).map((tab) => {
    // 「我的报修」复用工单池这个 tab 页。如果员工只被授予我的报修、
    // 没有工单池权限，底部入口也必须叫「我的报修」，否则会误以为能看全部待接单。
    if (
      tab.key === 'pool' &&
      access.pages &&
      !access.pages['app:pool'] &&
      access.pages['app:my-repairs']
    ) {
      return { ...tab, text: '我的报修' };
    }
    return tab;
  });
  // 企业管理员可能同时拥有全部 7 个入口。胶囊宽度固定，继续用五字标题会互相压住；
  // 只在入口超过 6 个时用短标题，权限较少的普通岗位仍保留完整名称。
  if (tabs.length <= 6) return tabs;
  const compact: Record<TabKey, string> = {
    dispatch: '派单', pool: '工单池', mine: '在手', maintenance: '养护',
    materials: '库存', approvals: '审批', me: '我的',
  };
  return tabs.map((tab) => ({ ...tab, text: compact[tab.key] }));
}

Component({
  data: {
    selectedKey: 'pool',
    /**
     * 页面上有底部弹层开着时整条胶囊都不渲染。
     *
     * 2026-08-31 实测：胶囊不参与页面内的 z-index 比较 —— 把弹层排到 200（胶囊是 100）
     * 之后，真机上「确认派单」那排按钮**照样被压住**。微信把自定义 tabBar 渲染在页面
     * 之上的另一层，页面里的 fixed 元素再高也盖不过它。所以唯一可靠的办法是藏掉它。
     * 由 utils/tabbar.ts 的 setTabBarHidden 驱动，tab 页的弹层开关处必须调。
     */
    hidden: false,
    tabs: visibleTabs({ pages: null }).map((tab) => ({ ...tab, badge: '' })),
  },

  lifetimes: {
    /**
     * 只读本地缓存的权限，**绝不在这里打任何要登录的接口**。
     *
     * 这里原来会在没缓存时调 auth.me() 补一次。auth.me() 是要登录的接口，
     * 没登录时返回 401 → 请求层触发 onUnauthorized → wx.reLaunch 回登录页 →
     * tabBar 重新 attached → 又调一次 auth.me() → 又 401 …… reLaunch 打转，
     * 整个小程序卡在登录页白屏。清掉小程序缓存反而必然触发。
     *
     * 缓存由各页拿到 /auth/me 时写入（utils/tabbar.ts 的 rememberAccess）。
     * 拿不到就全显示 —— 多一格也比整个小程序打不开强。
     */
    attached() {
      (this as any).applyAccess(readCachedAccess());
    },
  },

  methods: {
    applyAccess(access: TabAccess) {
      const badges: Record<string, string> = {};
      this.data.tabs.forEach((tab: any) => {
        badges[tab.key] = tab.badge;
      });
      this.setData({
        tabs: visibleTabs(access).map((tab) => ({ ...tab, badge: badges[tab.key] || '' })),
      });
    },

    onTap(e: WechatMiniprogram.BaseEvent) {
      // 勾过「总是保持」的人：切 tab 这一下顺手把提醒额度补上（微信不弹框、静默放行）。
      // 微信要求授权请求必须由点击直接触发，「打开小程序就自动补」做不到，
      // 切 tab 是打开之后最先发生的点击，效果最接近「自动」。必须放在任何 await 之前。
      topUpQuietly();
      const index = Number(e.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab || tab.key === this.data.selectedKey) return;

      // 工单池和派单台是同一个页面的两种模式，switchTab 不接受参数，
      // 所以把「进来要看哪一屏」写进缓存，页面读它决定渲染哪一屏
      rememberPoolMode(tab.key === 'dispatch' ? 'dispatch' : 'pool');
      if (tab.key === 'approvals' || tab.key === 'maintenance') {
        rememberApprovalMode(tab.key === 'maintenance' ? 'maintenance' : 'approvals');
      }

      const current = this.data.tabs.find((t: any) => t.key === this.data.selectedKey);
      const target = tab.pagePath.split('?')[0];
      const samePage = !!current && current.pagePath.split('?')[0] === target;

      if (samePage) {
        /**
         * 工单池 ↔ 派单台：目标就是当前停留的这个页面。
         *
         * wx.switchTab 跳到自己所在的页面**不保证触发 onShow**，靠它来刷新的话，
         * 表现就是「点了那一格没反应」；更麻烦的是缓存这时已经改了，
         * 等下次从别的 tab 回来，页面会莫名其妙换成另一种模式。
         * 所以这一步不走 switchTab：直接换高亮，再让页面自己重载。
         */
        this.setData({ selectedKey: tab.key });
        const pages = getCurrentPages();
        const page = pages[pages.length - 1] as any;
        if (page && typeof page.load === 'function') page.load();
        return;
      }

      wx.switchTab({ url: target });
    },

    /** 各 tab 页在 onShow 里调，告诉 tabBar 现在在哪一屏 */
    setActive(key: string) {
      if (this.data.selectedKey !== key) this.setData({ selectedKey: key });
    },

    /** 有弹层开着时把整条胶囊藏起来，见 data.hidden 的说明 */
    setHidden(hidden: boolean) {
      if (this.data.hidden !== !!hidden) this.setData({ hidden: !!hidden });
    },

    /** 未处理数量：0 或空表示不显示 */
    setBadge(key: string, count: number) {
      const index = this.data.tabs.findIndex((tab: any) => tab.key === key);
      if (index < 0) return;
      const value = Number(count) > 0 ? (Number(count) > 99 ? '99+' : String(count)) : '';
      if ((this.data.tabs[index] as any).badge === value) return;
      this.setData({ [`tabs[${index}].badge`]: value });
    },
  },
});
