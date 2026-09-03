import { notifications } from '@pms/api-client';
import type { NotificationItem } from '@pms/api-client/src/endpoints/notifications';
import {
  classifyNotification,
  formatDateTimeCn,
  type NotificationCategory,
  type NotificationPriority,
} from '@pms/shared-types';
import { refreshUnread } from '../../utils/unread';

/**
 * 员工端消息中心。目前主要是一件事：「有新工单派给你」。
 *
 * 为什么站内信不能省、只靠微信订阅消息：微信的一次性订阅是「同意一次推一条」，
 * 额度用完、没授权、或者物业还没申请模板，推送就发不出去。
 * 站内信是兜底 —— 至少人打开小程序能看到派了什么给他，而不是全靠自己去工单池里翻。
 */

type FilterKey = 'all' | 'important' | NotificationCategory;
type Row = NotificationItem & {
  timeText: string;
  page: string;
  desc: string;
  category: NotificationCategory;
  categoryLabel: string;
  categoryTone: string;
  priority: NotificationPriority;
  priorityLabel: string;
  important: boolean;
};
type FilterOption = { key: FilterKey; label: string; count: number };

const CATEGORY_FILTERS: Array<{ key: NotificationCategory; label: string }> = [
  { key: 'work_order', label: '工单' },
  { key: 'approval', label: '审批' },
  { key: 'inventory', label: '库存' },
  { key: 'system', label: '系统' },
  { key: 'other', label: '其他' },
];

function visibleRows(rows: Row[], filter: FilterKey): Row[] {
  if (filter === 'all') return rows;
  if (filter === 'important') return rows.filter((row) => row.important);
  return rows.filter((row) => row.category === filter);
}

function buildFilters(rows: Row[]): FilterOption[] {
  const result: FilterOption[] = [
    { key: 'all', label: '全部', count: rows.length },
    { key: 'important', label: '重要', count: rows.filter((row) => row.important).length },
  ];
  CATEGORY_FILTERS.forEach((item) => {
    const count = rows.filter((row) => row.category === item.key).length;
    if (count) result.push({ ...item, count });
  });
  return result;
}

Page({
  data: {
    allList: [] as Row[],
    list: [] as Row[],
    filters: [] as FilterOption[],
    activeFilter: 'all' as FilterKey,
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
      this.setData({ allList: [], list: [], filters: [], unread: 0, loaded: true });
      return;
    }
    try {
      const list = await notifications.list();
      const rows: Row[] = list.map((item) => ({
        ...item,
        ...classifyNotification(item.eventKey),
        timeText: formatDateTimeCn(item.createdAt),
        page: String(item.payload?.page || ''),
        // 派单备注和故障描述都在 payload 里，直接铺在标题下面——
        // 「有新工单」四个字没法让人判断要不要现在去
        desc: [item.payload?.note, item.payload?.content]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join('；'),
      }));
      const activeFilter = this.data.activeFilter;
      this.setData({
        allList: rows,
        list: visibleRows(rows, activeFilter),
        filters: buildFilters(rows),
        unread: list.filter((item) => !item.readAt).length,
        loaded: true,
      });
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onFilter(e: WechatMiniprogram.BaseEvent) {
    const activeFilter = String(e.currentTarget.dataset.key || 'all') as FilterKey;
    this.setData({
      activeFilter,
      list: visibleRows(this.data.allList, activeFilter),
    });
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
      wx.navigateTo({ url: `/${row.page}` });
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
