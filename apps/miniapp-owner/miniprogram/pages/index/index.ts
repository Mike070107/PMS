import { auth, repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { AuditStatus, type MeResp, type WorkOrderListItem } from '@pms/shared-types';
import { scanForToken } from '../../utils/scan';

interface OwnerApp {
  setTokens: (a: string, r: string) => void;
  clearTokens: () => void;
}

type OrderRow = WorkOrderListItem & { typeLabel: string; createdAtText: string };

/** 入驻状态 → 首页提示语与可执行动作 */
const AUDIT_HINT: Record<string, { text: string; tone: 'pending' | 'ok' | 'error' }> = {
  [AuditStatus.PENDING]: { text: '房屋认证审核中，物业核对后即可正常报修', tone: 'pending' },
  [AuditStatus.APPROVED]: { text: '房屋已认证', tone: 'ok' },
  [AuditStatus.REJECTED]: { text: '房屋认证未通过，请重新提交', tone: 'error' },
};

Page({
  data: {
    loading: false,
    loggedIn: false,
    me: null as MeResp | null,
    placeText: '',
    auditText: '',
    auditTone: '',
    needOnboard: false,     // 还没提交入驻
    canQuickRepair: false,  // 有绑定房屋，可直接报修
    recent: [] as OrderRow[],
    loadedRecent: false,
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    if (!wx.getStorageSync('pms.access_token')) {
      this.setData({ loggedIn: false, me: null, recent: [], loadedRecent: false });
      return;
    }
    this.setData({ loggedIn: true });
    try {
      const me = await auth.me();
      const place = me.place ?? null;
      const hint = place ? AUDIT_HINT[place.auditStatus] : undefined;
      this.setData({
        me,
        placeText: place?.addressText || '',
        auditText: hint?.text || '',
        auditTone: hint?.tone || '',
        needOnboard: !place || place.auditStatus === AuditStatus.REJECTED,
        canQuickRepair: !!place && place.auditStatus !== AuditStatus.REJECTED,
      });
    } catch {
      // me 拿不到不影响首页主操作
    }
    this.loadRecent();
  },

  async loadRecent() {
    try {
      const list = await repairs.list({ scope: 'mine' });
      this.setData({ recent: withOrderLabels(list.slice(0, 3)), loadedRecent: true });
    } catch {
      this.setData({ loadedRecent: true });
    }
  },

  /** 返回是否已登录；未登录会就地拉起微信登录 */
  async ensureLogin(): Promise<boolean> {
    if (this.data.loggedIn) return true;
    return this.login();
  },

  async login(): Promise<boolean> {
    if (this.data.loading) return false;
    this.setData({ loading: true });
    try {
      const { code } = await wx.login();
      const resp = await auth.loginByCode({ code, appType: 'owner' });
      getApp<OwnerApp>().setTokens(resp.accessToken, resp.refreshToken);
      this.setData({ loggedIn: true });
      await this.refresh();
      return true;
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '登录失败' });
      return false;
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapLogin() {
    this.login();
  },

  onTapOnboard() {
    wx.navigateTo({ url: '/pages/onboard/onboard' });
  },

  /** 随手拍：拍照 + 一句话，类型由系统判定 */
  async onTapSnapRepair() {
    if (!(await this.ensureLogin())) return;
    if (!this.data.me?.place) return this.onTapOnboard();
    wx.navigateTo({ url: '/pages/quick-repair/quick-repair' });
  },

  /** 用已认证的房屋走完整报修单 */
  async onTapQuickRepair() {
    if (!(await this.ensureLogin())) return;
    const place = this.data.me?.place;
    if (!place) return this.onTapOnboard();
    // 房屋信息整套带过去：房号预填、houseId 也带上，
    // 否则工单挂不到这套房，页面还要让业主再找一遍自己家
    wx.navigateTo({
      url: `/pages/repair-create/repair-create?communityId=${place.communityId}` +
        `&buildingId=${place.buildingId ?? ''}` +
        `&houseId=${place.houseId ?? ''}` +
        `&communityName=${encodeURIComponent(place.communityName || '')}` +
        `&buildingText=${encodeURIComponent(place.buildingText || '')}` +
        `&roomNo=${encodeURIComponent(place.roomNo || '')}` +
        `&place=${encodeURIComponent(place.addressText)}`,
    });
  },

  /** 扫楼道/单元门口的码报修（也可给未入驻的人用） */
  async onTapScan() {
    if (!(await this.ensureLogin())) return;
    const token = await scanForToken();
    if (!token) return;
    const page = this.data.needOnboard ? 'onboard/onboard' : 'repair-create/repair-create';
    wx.navigateTo({ url: `/pages/${page}?token=${encodeURIComponent(token)}` });
  },

  onTapOrder(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },

  onTapAllOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },
});
