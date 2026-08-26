/**
 * 自定义 tabBar。
 *
 * 为什么不用微信原生 tabBar：原生只认本地 png 图标，也没法按角色藏 tab。
 * 之前四个 tab 只有文字、当前项只靠一点点蓝，站在楼道里扫一眼分不清自己在哪一屏、
 * 哪里有活要干；维修工点「审批」进去还永远是一句「你没权限」—— 这些都是
 * 「不知道该点哪里」的具体来源。
 *
 * 现在：SVG 图标（wxss data URI，跟着主题色走）＋ 当前项加粗高亮 ＋ 未处理数量角标，
 * 且没权限的 tab 直接不渲染。角标由各页面加载完数据后调 setBadge 更新，
 * tabBar 自己不发列表请求，避免每次切 tab 都多打一遍接口。
 *
 * 三种身份看到的是三套 tab（显隐判断在 utils/roles.ts 的 canSeeTab，只此一份）：
 *   维修工：工单池 / 在手工单 / 我的
 *   办公室一侧：派单台 / 材料与库存 / 审批 / 我的
 *   代报身份：我的报修 / 我的
 * 办公室没有「在手工单」—— 单不会派到他自己头上，那一格永远是空的。
 *
 * 身份和权限都来自后台的角色（2026-08-26 业务身份并进角色表），
 * 各页拿到 /auth/me 时顺手写进缓存（utils/tabbar.ts 的 rememberAccess），
 * 所以后台改完角色，用户下拉刷新一次底部就跟着变，不用杀掉小程序重进。
 */
import { canSeeTab, isDispatcher, isReporter, type TabAccess, type TabKey } from '../utils/roles';
import { readCachedAccess } from '../utils/tabbar';

interface TabDef {
  key: TabKey;
  pagePath: string;
  text: string;
  /** 代报身份看到的另一种叫法 */
  reporterText?: string;
  /** 办公室一侧看到的另一种叫法（同一个池子，他们是去派单不是去接单） */
  dispatcherText?: string;
}

const ALL_TABS: TabDef[] = [
  {
    key: 'pool',
    pagePath: '/pages/pool/pool',
    text: '工单池',
    dispatcherText: '派单台',
  },
  {
    key: 'mine',
    pagePath: '/pages/my-orders/my-orders',
    text: '在手工单',
    reporterText: '我的报修',
  },
  // 办公室把「在手工单」那一格换成材料与库存：查库存、补 SKU 是他们每天要干的事。
  // 落地页是库存（不是 SKU 清单）—— 先回答「还有几个」，再顺手改这条 SKU
  {
    key: 'materials',
    pagePath: '/pages/inventory/inventory',
    text: '材料与库存',
  },
  // 维修工没有采购审批权限，这一项对他们不显示
  { key: 'approvals', pagePath: '/pages/approvals/approvals', text: '审批' },
  { key: 'me', pagePath: '/pages/me/me', text: '我的' },
];

function visibleTabs(access: TabAccess) {
  const reporter = isReporter(access.role);
  const dispatcher = isDispatcher(access.role);
  return ALL_TABS.filter((tab) => canSeeTab(tab.key, access)).map((tab) => {
    if (dispatcher && tab.dispatcherText) return { ...tab, text: tab.dispatcherText };
    if (reporter && tab.reporterText) return { ...tab, text: tab.reporterText };
    return tab;
  });
}

Component({
  data: {
    selectedKey: 'pool',
    tabs: visibleTabs({ role: '', pages: null }).map((tab) => ({ ...tab, badge: '' })),
  },

  lifetimes: {
    /**
     * 只读本地缓存的身份与权限，**绝不在这里打任何要登录的接口**。
     *
     * 这里原来会在没缓存角色时调 auth.me() 补一次。auth.me() 是要登录的接口，
     * 没登录时返回 401 → 请求层触发 onUnauthorized → wx.reLaunch 回登录页 →
     * tabBar 重新 attached → 又调一次 auth.me() → 又 401 …… reLaunch 打转，
     * 整个小程序卡在登录页白屏。清掉小程序缓存反而必然触发（角色缓存也被清了）。
     *
     * 缓存由两处写入，足够了：登录成功时 login.ts 直接写角色，之后各页拿到 auth.me()
     * 时顺手刷新身份和权限（utils/tabbar.ts 的 rememberAccess）。
     * 拿不到就全显示 —— 多一个 tab 也比整个小程序打不开强。
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
      wx.switchTab({ url: tab.pagePath });
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
