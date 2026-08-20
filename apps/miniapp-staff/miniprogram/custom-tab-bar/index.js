const { auth } = require('@pms/api-client');

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
const ALL_TABS = [
  { key: 'pool', pagePath: '/pages/pool/pool', text: '工单池' },
  { key: 'mine', pagePath: '/pages/my-orders/my-orders', text: '在手工单' },
  // 维修工没有采购审批权限，这一项对他们不显示
  { key: 'approvals', pagePath: '/pages/approvals/approvals', text: '审批', roles: ['manager', 'purchaser', 'admin'] },
  { key: 'me', pagePath: '/pages/me/me', text: '我的' },
];

const ROLE_KEY = 'pms.staff.role';

function visibleTabs(role) {
  // 角色还没拿到时先全显示：宁可多一个 tab，也别让有权限的人以为功能没了
  return ALL_TABS.filter((tab) => !tab.roles || !role || tab.roles.indexOf(role) >= 0);
}

Component({
  data: {
    selectedKey: 'pool',
    tabs: visibleTabs('').map((tab) => ({ ...tab, badge: '' })),
  },

  lifetimes: {
    attached() {
      this.applyRole(wx.getStorageSync(ROLE_KEY) || '');
      // 角色只在启动后取一次，之后各页面 auth.me() 的结果会顺手刷新缓存
      if (!wx.getStorageSync(ROLE_KEY)) {
        auth
          .me()
          .then((me) => {
            wx.setStorageSync(ROLE_KEY, me.role);
            this.applyRole(me.role);
          })
          .catch(() => {
            // 没登录/网络不通就维持全显示，登录后再进来自然会刷新
          });
      }
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
