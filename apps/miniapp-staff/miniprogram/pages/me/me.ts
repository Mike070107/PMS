import { maskPhone } from '@pms/miniapp-ui';
import { USER_ROLE_LABELS, type MeResp } from '@pms/shared-types';
import { clearSession, getSession } from '../../utils/session';
import { syncTabBar } from '../../utils/tabbar';

/** 构建版本：随每次上传更新。开发版/预览版微信不返回版本号，靠它确认跑的是哪份代码 */
const BUILD_VERSION = '1.0.20260825e';

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
        repairDesc: isReporter
          ? (scope ? `可报 ${scope} 内任意楼栋房号` : '还没有可代报的小区，请联系物业管理员开通')
          : '巡查发现的问题直接提单，地址可选全公司任意楼栋房号',
      });
    } catch {
      // 未登录时由请求层跳转登录页
    }
  },

  onGoRepair() {
    wx.navigateTo({ url: '/pages/repair-create/repair-create' });
  },

  /** 材料库是 tabBar 页（办公室一侧的第二格），只能 switchTab —— navigateTo 会静默失败 */
  onOpenMaterials() {
    wx.switchTab({ url: '/pages/materials/materials' });
  },

  onOpenInventory() {
    wx.navigateTo({ url: '/pages/inventory/inventory' });
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
