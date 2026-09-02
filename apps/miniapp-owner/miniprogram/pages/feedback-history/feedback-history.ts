import { observability, type FeedbackStatus, type MyFeedbackItem } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/shared-types';

const STATUS_META: Record<string, { label: string; tone: string }> = {
  new: { label: '待处理', tone: 'new' },
  processing: { label: '处理中', tone: 'processing' },
  resolved: { label: '已解决', tone: 'resolved' },
  ignored: { label: '已有结果', tone: 'ignored' },
};
const TYPE_LABEL: Record<string, string> = {
  error: '页面报错',
  hard_to_use: '不好用',
  data_issue: '数据不对',
  suggestion: '改进建议',
  other: '其他',
};

type HistoryRow = {
  status: FeedbackStatus;
  statusText: string;
  tone: string;
  note: string;
  timeText: string;
};
type FeedbackRow = MyFeedbackItem & {
  statusText: string;
  tone: string;
  typeText: string;
  timeText: string;
  imageUrls: string[];
  videos: string[];
  progress: HistoryRow[];
  highlighted: boolean;
};

Page({
  data: {
    list: [] as FeedbackRow[],
    loaded: false,
    loading: false,
    focusId: 0,
  },

  onLoad(options: Record<string, string>) {
    this.setData({ focusId: Number(options.id || 0) });
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const raw = await observability.myFeedback();
      const rows = raw.map((item) => {
        const status = STATUS_META[item.status] || STATUS_META.new;
        return {
          ...item,
          statusText: status.label,
          tone: status.tone,
          typeText: TYPE_LABEL[item.type] || TYPE_LABEL.other,
          timeText: formatDateTimeCn(item.createdAt),
          imageUrls: item.attachments.filter((file) => file.type === 'image').map((file) => file.url),
          videos: item.attachments.filter((file) => file.type === 'video').map((file) => file.url),
          progress: item.history
            .filter((step) => step.status !== 'new' || !!step.note)
            .slice()
            .reverse()
            .map((step) => {
              const meta = STATUS_META[step.status] || STATUS_META.new;
              return {
                ...step,
                statusText: meta.label,
                tone: meta.tone,
                timeText: step.at ? formatDateTimeCn(step.at) : '',
              };
            }),
          highlighted: item.id === this.data.focusId,
        };
      });
      if (this.data.focusId) {
        rows.sort((a, b) => Number(b.id === this.data.focusId) - Number(a.id === this.data.focusId));
      }
      this.setData({ list: rows, loaded: true });
    } catch (error: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: error?.message || '反馈记录加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPreviewImage(e: WechatMiniprogram.BaseEvent) {
    const current = String(e.currentTarget.dataset.url || '');
    const urls = (e.currentTarget.dataset.urls || []) as string[];
    if (current && urls.length) wx.previewImage({ current, urls });
  },
});
