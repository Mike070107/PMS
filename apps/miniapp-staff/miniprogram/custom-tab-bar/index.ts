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
import { readCachedAccess } from '../utils/tabbar';

interface TabDef {
  key: TabKey;
  pagePath: string;
  text: string;
}

// 工单池和派单台是两格：一个是「有活我领」，一个是「有活我派给谁」。
// 同一个角色两格都勾也行（比如维修组长），底部就都显示。
const ALL_TABS: TabDef[] = [
  { key: 'pool', pagePath: '/pages/pool/pool', text: '工单池' },
  { key: 'dispatch', pagePath: '/pages/pool/pool?mode=dispatch', text: '派单台' },
  { key: 'mine', pagePath: '/pages/my-orders/my-orders', text: '在手工单' },
  { key: 'materials', pagePath: '/pages/inventory/inventory', text: '材料与库存' },
  { key: 'approvals', pagePath: '/pages/approvals/approvals', text: '审批' },
  { key: 'me', pagePath: '/pages/me/me', text: '我的' },
];

function visibleTabs(access: TabAccess) {
  return ALL_TABS.filter((tab) => canSeeTab(tab.key, access));
}

Component({
  data: {
    selectedKey: 'pool',
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
      const index = Number(e.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab || tab.key === this.data.selectedKey) return;
      // 工单池和派单台是同一个页面的两种模式，switchTab 不接受参数，
      // 所以把「进来要看哪一屏」也写进缓存，页面 onShow 时读
      try {
        wx.setStorageSync('pms.staff.poolMode', tab.key === 'dispatch' ? 'dispatch' : 'pool');
      } catch {
        /* 存不下不影响跳转，页面会按权限自己判默认模式 */
      }
      wx.switchTab({ url: tab.pagePath.split('?')[0] });
    },

    /** 各 tab 页在 onShow 里调，告诉 tabBar 现在在哪一屏 */
    setActive(key: string) {
      if (this.data.selectedKey !== key) this.setData({ selectedKey: key });
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
