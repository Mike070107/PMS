import { notifications } from '@pms/api-client';
import type { NotificationItem } from '@pms/api-client/src/endpoints/notifications';
import {
  classifyNotification,
  formatDateTimeCn,
  type NotificationCategory,
  type NotificationPriority,
} from '@pms/shared-types';
import { refreshUnreadBadge } from '../../utils/unread';

type FilterKey = 'all' | 'important' | NotificationCategory;
type Row = NotificationItem & {
  timeText: string;
  page: string;
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

  async load() {
    if (!wx.getStorageSync('pms.access_token')) {
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
      refreshUnreadBadge();
    }
    if (row.page) {
      wx.navigateTo({ url: `/${row.page}` });
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
