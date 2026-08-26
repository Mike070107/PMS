import { maskPhone } from '@pms/miniapp-ui';
import { USER_ROLE_LABELS, type MeResp } from '@pms/shared-types';
import { clearSession, getSession } from '../../utils/session';
import { syncTabBar } from '../../utils/tabbar';
import { askOrderSubscribe, isAlwaysAllowed, refreshUnread } from '../../utils/unread';

/** 构建版本：随每次上传更新。开发版/预览版微信不返回版本号，靠它确认跑的是哪份代码 */
const BUILD_VERSION = '1.0.20260826c';

Page({
  data: {
    buildText: '',
    user: null as MeResp | null,
    roleText: '',
    phoneText: '',
    /** 头像用姓名首字，没名字就用角色首字 */
    avatarText: '',
    canUseMaterials: false,
    canUseInventory: false,
    /** 未读消息数，显示在「消息」入口右侧 */
    unread: 0,
    /** 维修工才有「新工单提醒」这回事 —— 单是派给他的 */
    canSubscribe: false,
    /** 已勾「总是保持以上选择」= 以后每次派单都会提醒，不用再点 */
    notifyAlways: false,
    /** 代报角色：报修范围是授权小区，不是全公司，文案得说准 */
    repairDesc: '巡查发现的问题直接提单，地址可选全公司任意楼栋房号',
  },

  /** 显示当前跑的是哪个包：改完重新上传后，忘记「选为体验版本」一眼就能看出来 */
  showBuild() {
    try {
      const info = wx.getAccountInfoSync().miniProgram;
      const envText = { develop: '开发版', trial: '体验版', release: '正式版' }[info.envVersion] || info.envVersion;
      this.setData({ buildText: [envText, info.version || BUILD_VERSION].filter(Boolean).join(' ') });
    } catch {
      this.setData({ buildText: '' });
    }
  },

  onShow() {
    syncTabBar(this, 'me');
    this.showBuild();
    this.load();
    // 未读数每次进来都重新拉：小程序没有推到端的长连接，角标只能主动拿
    refreshUnread(this).then((unread) => this.setData({ unread }));
  },

  async load() {
    try {
      // 身份和权限都从这一份会话来（utils/session.ts），页面里不再各写角色白名单
      const session = await getSession(this, true);
      const user = session.me as MeResp;
      const roleText = USER_ROLE_LABELS[user.role] || user.role;
      const isReporter = session.isReporter;
      // 授权小区在 me().reporter 里，报修范围就照它写 —— 写成「全公司」会让保安
      // 选到没授权的小区，提交时才被后端拦下（assertCanReportAt），白填一遍
      const scope = (user.reporter?.communities || []).map((c) => c.name).join('、');
      this.setData({
        user,
        roleText,
        phoneText: maskPhone(user.phone),
        avatarText: (user.name || roleText || '员').trim().charAt(0),
        canUseMaterials: session.canViewMaterials,
        canUseInventory: session.canViewInventory,
        canSubscribe: session.isTechnician,
        repairDesc: isReporter
          ? (scope ? `可报 ${scope} 内任意楼栋房号` : '还没有可代报的小区，请联系物业管理员开通')
          : '巡查发现的问题直接提单，地址可选全公司任意楼栋房号',
      });
      if (session.isTechnician) this.refreshNotifyState();
    } catch {
      // 未登录时由请求层跳转登录页
    }
  },

  onGoRepair() {
    wx.navigateTo({ url: '/pages/repair-create/repair-create' });
  },

  /**
   * 材料与库存现在是一屏（tabBar 页），只能 switchTab —— navigateTo 打不开 tab 页。
   * 原来这里有两个入口（材料 SKU 库 / 库存与采购），点进去是两份长得差不多的清单。
   */
  onOpenInventory() {
    wx.switchTab({ url: '/pages/inventory/inventory' });
  },

  onOpenMessages() {
    wx.navigateTo({ url: '/pages/messages/messages' });
  },

  /** 用户主动点「开启新工单提醒」：要给明确反馈，不能静默失败 */
  async onEnableNotify() {
    await askOrderSubscribe(false);
    await this.refreshNotifyState();
  },

  /**
   * 「开启新工单提醒」这一项显示的是当前状态，不是一个动作按钮 ——
   * 已经勾过「总是保持」的人再看到「开启提醒」会以为没生效，又点一遍。
   */
  async refreshNotifyState() {
    const me = this.data.user;
    const tmplId = (me?.subscribeTemplates || [])[0] || '';
    this.setData({ notifyAlways: tmplId ? await isAlwaysAllowed(tmplId) : false });
  },

  async onLogout() {
    const res = await wx.showModal({
      title: '退出登录',
      content: '退出后需重新验证身份，微信绑定不会解除',
    });
    if (!res.confirm) return;
    getApp<{ clearTokens: () => void }>().clearTokens();
    // 角色和会话缓存都要清掉：换个人登进来，tabBar 和各页面不该还按上一个人的权限渲染
    wx.removeStorageSync('pms.staff.role');
    clearSession();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
