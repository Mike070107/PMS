import { auth } from '@pms/api-client';
import { maskPhone } from '@pms/miniapp-ui';
import { UserRole, type MeResp } from '@pms/shared-types';
import { rememberRole, syncTabBar } from '../../utils/tabbar';

/** 构建版本：随每次上传更新。开发版/预览版微信不返回版本号，靠它确认跑的是哪份代码 */
const BUILD_VERSION = '1.0.20260810a';

const ROLE_TEXT: Record<string, string> = {
  [UserRole.TECHNICIAN]: '维修工',
  [UserRole.OFFICE]: '物业办公室',
  [UserRole.MANAGER]: '物业经理',
  [UserRole.PURCHASER]: '采购经理',
  [UserRole.ADMIN]: '物业管理员',
};

/** 和后端 /materials、/stocks 的读权限一致 */
const INVENTORY_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.PURCHASER,
  UserRole.OFFICE,
];

Page({
  data: {
    buildText: '',
    user: null as MeResp | null,
    roleText: '',
    phoneText: '',
    /** 头像用姓名首字，没名字就用角色首字 */
    avatarText: '',
    canUseInventory: false,
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
      const user = await auth.me();
      rememberRole(this, user.role);
      const roleText = ROLE_TEXT[user.role] || user.role;
      this.setData({
        user,
        roleText,
        phoneText: maskPhone(user.phone),
        avatarText: (user.name || roleText || '员').trim().charAt(0),
        canUseInventory: INVENTORY_ROLES.includes(user.role),
      });
    } catch {
      // 未登录时由请求层跳转登录页
    }
  },

  onOpenMaterials() {
    wx.navigateTo({ url: '/pages/materials/materials' });
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
    // 角色也要清掉：换个人登进来，tabBar 不该还按上一个人的权限显示
    wx.removeStorageSync('pms.staff.role');
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
