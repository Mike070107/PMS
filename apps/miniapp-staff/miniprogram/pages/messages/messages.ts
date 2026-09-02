import { notifications } from '@pms/api-client';
import type { NotificationItem } from '@pms/api-client/src/endpoints/notifications';
import { formatDateTimeCn } from '@pms/shared-types';
import { refreshUnread } from '../../utils/unread';

/**
 * 员工端消息中心。目前主要是一件事：「有新工单派给你」。
 *
 * 为什么站内信不能省、只靠微信订阅消息：微信的一次性订阅是「同意一次推一条」，
 * 额度用完、没授权、或者物业还没申请模板，推送就发不出去。
 * 站内信是兜底 —— 至少人打开小程序能看到派了什么给他，而不是全靠自己去工单池里翻。
 */

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

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 登录态问 app 拿：员工端的 key 是 pms.staff.access_token，别写死（见 utils/unread.ts）
    const token = getApp<{ getToken(): string | undefined }>()?.getToken();
    if (!token) {
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
          // 派单备注和故障描述都在 payload 里，直接铺在标题下面 ——
          // 「有新工单」四个字没法让人判断要不要现在去
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
      refreshUnread();
    }
    if (row.page) {
      wx.navigateTo({ url: row.page.startsWith('/') ? row.page : `/${row.page}` });
      return;
    }
    this.load();
  },

  async onReadAll() {
    try {
      await notifications.markAllRead();
      refreshUnread();
      this.load();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '操作失败' });
    }
  },
});
