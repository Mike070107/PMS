import { notifications } from '@pms/api-client';
import type { NotificationItem } from '@pms/api-client/src/endpoints/notifications';
import { formatDateTimeCn } from '@pms/shared-types';
import { refreshUnreadBadge } from '../../utils/unread';

type Row = NotificationItem & { timeText: string; page: string; desc: string };

Page({
  data: {
    list: [] as Row[],
    unread: 0,
    loaded: false,
  },

  onShow() {
    this.load();
  },

  async load() {
    if (!wx.getStorageSync('pms.access_token')) {
      this.setData({ list: [], unread: 0, loaded: true });
      return;
    }
    try {
      const list = await notifications.list();
      this.setData({
        list: list.map((item) => ({
          ...item,
          timeText: formatDateTimeCn(item.createdAt),
          page: String(item.payload?.page || ''),
          desc: [item.payload?.note, item.payload?.content]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join('；'),
        })),
        unread: list.filter((item) => !item.readAt).length,
        loaded: true,
      });
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  /**
   * 点一条：先标已读再跳转。
   * 标已读失败不拦跳转 —— 用户要看的是工单，红点晚一次刷新没关系。
   */
  async onTapItem(e: WechatMiniprogram.BaseEvent) {
    const row = this.data.list[Number(e.currentTarget.dataset.index)];
    if (!row) return;

    if (!row.readAt) {
      await notifications.markRead(row.id).catch(() => null);
      refreshUnreadBadge();
    }
    if (row.page) {
      wx.navigateTo({ url: row.page.startsWith('/') ? row.page : `/${row.page}` });
      return;
    }
    // 没有落地页的消息（比如纯公告）就只标已读，本地把圆点灭掉
    this.load();
  },

  async onReadAll() {
    try {
      await notifications.markAllRead();
      refreshUnreadBadge();
      this.load();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '操作失败' });
    }
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
});
