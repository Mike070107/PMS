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
 */
/** 干物业活的角色：能接单、看工单池。代报角色（保安等）不在内 */
const WORKER_ROLES = ['technician', 'office', 'manager', 'purchaser', 'admin'];

/**
 * 代报角色 2026-08-24 从业主端搬进员工端，但他们只报修、不接单 ——
 * 工单池对他们没有意义（点进去全是别人要修的活），「在手工单」也不是在手的活，
 * 而是自己报上去的单，所以这里连文案一起换掉。
 */
const REPORTER_ROLES = ['guard', 'neighborhood', 'owner_committee', 'property_staff'];

const ALL_TABS = [
  { key: 'pool', pagePath: '/pages/pool/pool', text: '工单池', roles: WORKER_ROLES },
  { key: 'mine', pagePath: '/pages/my-orders/my-orders', text: '在手工单', reporterText: '我的报修' },
  // 维修工没有采购审批权限，这一项对他们不显示
  { key: 'approvals', pagePath: '/pages/approvals/approvals', text: '审批', roles: ['manager', 'purchaser', 'admin'] },
  { key: 'me', pagePath: '/pages/me/me', text: '我的' },
];

const ROLE_KEY = 'pms.staff.role';

function visibleTabs(role) {
  const isReporter = REPORTER_ROLES.indexOf(role) >= 0;
  // 角色还没拿到时先全显示：宁可多一个 tab，也别让有权限的人以为功能没了
  return ALL_TABS.filter((tab) => !tab.roles || !role || tab.roles.indexOf(role) >= 0).map((tab) =>
    isReporter && tab.reporterText ? { ...tab, text: tab.reporterText } : tab,
  );
}

Component({
  data: {
    selectedKey: 'pool',
    tabs: visibleTabs('').map((tab) => ({ ...tab, badge: '' })),
  },

  lifetimes: {
    /**
     * 只读本地缓存的角色，**绝不在这里打任何要登录的接口**。
     *
     * 这里原来会在没缓存角色时调 auth.me() 补一次。auth.me() 是要登录的接口，
     * 没登录时返回 401 → 请求层触发 onUnauthorized → wx.reLaunch 回登录页 →
     * tabBar 重新 attached → 又调一次 auth.me() → 又 401 …… reLaunch 打转，
     * 整个小程序卡在登录页白屏。清掉小程序缓存反而必然触发（角色缓存也被清了）。
     *
     * 角色由两处写入，足够了：登录成功时 login.ts 直接写，之后「我的」「审批」
     * 页拿到 auth.me() 时顺手刷新（utils/tabbar.ts 的 rememberRole）。
     * 拿不到角色就全显示 —— 多一个 tab 也比整个小程序打不开强。
     */
    attached() {
      this.applyRole(wx.getStorageSync(ROLE_KEY) || '');
    },
  },

  methods: {
    applyRole(role) {
      const badges = {};
      this.data.tabs.forEach((tab) => {
        badges[tab.key] = tab.badge;
      });
      this.setData({
        tabs: visibleTabs(role).map((tab) => ({ ...tab, badge: badges[tab.key] || '' })),
      });
    },

    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab || tab.key === this.data.selectedKey) return;
      wx.switchTab({ url: tab.pagePath });
    },

    /** 各 tab 页在 onShow 里调，告诉 tabBar 现在在哪一屏 */
    setActive(key) {
      if (this.data.selectedKey !== key) this.setData({ selectedKey: key });
    },

    /** 未处理数量：0 或空表示不显示 */
    setBadge(key, count) {
      const index = this.data.tabs.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const value = Number(count) > 0 ? (Number(count) > 99 ? '99+' : String(count)) : '';
      if (this.data.tabs[index].badge === value) return;
      this.setData({ [`tabs[${index}].badge`]: value });
    },
  },
});
