import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceNoteSummary, RepairExperienceNotebookView } from '@pms/shared-types';
import { guideHandlers } from '../../utils/guide';

/**
 * 维修经验总结（列表）
 *
 * 2026-09-04 Mike：本子一多列表就太长、看着乱。改成：
 *   · 收藏过的帖子单独一块，一直摊开在最上面（星在每行右侧，详情页也有）；
 *   · 各本子默认收起，只露名字和篇数，点名字展开；人手动展开/收起过的，刷新后保持；
 *   · 搜索框：关键词交给服务端在自己看得到的本子里搜标题和正文，搜的时候本子全部展开；
 *   · 「本管理处公共」本子由服务端按管理处附带，同一管理处的人都能看、能写。
 * 本子范围本来就按人收敛（维修工只有自己工种的，办公室是整个管理处，见服务端
 * repair-experiences.service.ts allowedNotebooks），端上不再筛。
 */
type NotebookRow = RepairExperienceNotebookView & { key: string; open: boolean };
type FavoriteRow = RepairExperienceNoteSummary & { scope: string };

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    keyword: '',
    /** 真正发出去搜的词；输入框里还没点搜索的字不算 */
    query: '',
    favorites: [] as FavoriteRow[],
    notebooks: [] as NotebookRow[],
    loaded: false,
  },

  /** 人手动展开/收起过的本子，刷新后保持；换关键词时清空 */
  openKeys: {} as Record<string, boolean>,

  onShow() {
    this.syncGuide();
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    const query = this.data.query;
    try {
      const books = await repairExperiences.list(query || undefined);
      if (query !== this.data.query) return; // 等待期间又搜了别的词，这一批作废
      const favorites: FavoriteRow[] = [];
      const notebooks: NotebookRow[] = books.map((book) => {
        const key = `${book.officeId}:${book.repairType}`;
        for (const note of book.notes) {
          if (note.favorite) favorites.push({ ...note, scope: `${book.officeName} · ${book.repairTypeLabel}` });
        }
        const manual = this.openKeys[key];
        const open = manual !== undefined ? manual : !!query || books.length === 1;
        return { ...book, key, open };
      });
      this.setData({ favorites, notebooks, loaded: true });
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onKeyword(e: WechatMiniprogram.Input) { this.setData({ keyword: e.detail.value }); },
  onSearch() {
    const query = this.data.keyword.trim();
    this.openKeys = {};
    this.setData({ query });
    this.load();
  },
  onClearKeyword() {
    this.openKeys = {};
    this.setData({ keyword: '', query: '' });
    this.load();
  },

  onToggleNotebook(e: WechatMiniprogram.BaseEvent) {
    const key = String(e.currentTarget.dataset.key);
    const index = this.data.notebooks.findIndex((book) => book.key === key);
    if (index < 0) return;
    const open = !this.data.notebooks[index].open;
    this.openKeys[key] = open;
    this.setData({ [`notebooks[${index}].open`]: open });
  },

  async onToggleFavorite(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const on = !Number(e.currentTarget.dataset.on);
    try {
      await repairExperiences.setFavorite(id, on);
      wx.showToast({ icon: 'none', title: on ? '已收藏，放到最上面了' : '已取消收藏' });
      await this.load();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '操作失败' });
    }
  },

  onOpen(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/experience-note/experience-note?id=${e.currentTarget.dataset.id}` });
  },

  onCreate(e: WechatMiniprogram.BaseEvent) {
    const { officeId, repairType, officeName, typeLabel } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/experience-note/experience-note?officeId=${officeId}&repairType=${encodeURIComponent(repairType)}&officeName=${encodeURIComponent(officeName)}&typeLabel=${encodeURIComponent(typeLabel)}`,
    });
  },
});
