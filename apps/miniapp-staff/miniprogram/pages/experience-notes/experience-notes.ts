import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceNotebookView } from '@pms/shared-types';

Page({
  data: {
    notebooks: [] as RepairExperienceNotebookView[],
    loaded: false,
  },

  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      this.setData({ notebooks: await repairExperiences.list(), loaded: true });
    } catch (e: any) {
      this.setData({ loaded: true });
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
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
