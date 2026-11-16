import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceLibraryQuery } from '@pms/shared-types';
import { experienceRow, experienceTypes, experienceError, type ExperienceCommunity } from '../../utils/experience-library';

Page({
  data: {
    keyword: '', query: '', view: 'all' as NonNullable<RepairExperienceLibraryQuery['view']>,
    views: [{ value: 'all', label: '全部可见' }, { value: 'mine', label: '我写的' }, { value: 'private', label: '仅我可见' }, { value: 'favorites', label: '收藏' }],
    items: [] as ReturnType<typeof experienceRow>[], total: 0, page: 0, pageSize: 20,
    loading: false, loadingMore: false, loaded: false, error: '', optionsError: '',
    canCreate: false, filtersOpen: false, communities: [] as ExperienceCommunity[],
    communityNames: ['全部小区'], communityIndex: 0, communityId: 0,
    repairTypes: [] as { value: string; label: string }[], repairTypeNames: ['全部工种'], repairTypeIndex: 0, repairType: '',
  },
  requestVersion: 0, optionsVersion: 0, destroyed: false,
  searchTimer: null as ReturnType<typeof setTimeout> | null,
  favoriteLocks: {} as Record<number, boolean>,
  async onShow() { this.destroyed = false; await Promise.all([this.loadOptions(), this.load()]); },
  onUnload() { this.destroyed = true; this.requestVersion++; this.optionsVersion++; if (this.searchTimer) clearTimeout(this.searchTimer); },
  async onPullDownRefresh() { try { await this.loadOptions(); await this.load(); } finally { wx.stopPullDownRefresh(); } },
  onRetry() { return this.load(); },
  async loadOptions() {
    const version = ++this.optionsVersion;
    this.setData({ canCreate: false });
    try {
      const options = await repairExperiences.sharingOptions();
      if (this.destroyed || version !== this.optionsVersion) return;
      const communities = options.communities;
      this.setData({ communities, canCreate: options.canCreate === true, optionsError: '', communityNames: ['全部小区', ...communities.map((c) => c.name)] });
      this.syncTypeOptions();
    } catch (e: any) { if (!this.destroyed && version === this.optionsVersion) this.setData({ canCreate: false, optionsError: experienceError(e, '新建与筛选权限加载失败') }); }
  },
  syncTypeOptions() {
    const selected = this.data.communityId ? this.data.communities.filter((c) => c.id === this.data.communityId) : this.data.communities;
    const repairTypes = experienceTypes(selected);
    this.setData({ repairTypes, repairTypeNames: ['全部工种', ...repairTypes.map((t) => t.label)] });
  },
  async load(append = false) {
    if (append && (this.data.loadingMore || this.data.loading || this.data.items.length >= this.data.total)) return;
    const version = ++this.requestVersion;
    const page = append ? this.data.page + 1 : 1;
    const query: RepairExperienceLibraryQuery = { q: this.data.query || undefined, view: this.data.view, communityId: this.data.communityId || undefined, repairType: this.data.repairType || undefined, page, pageSize: this.data.pageSize };
    this.setData({ loading: !append, loadingMore: append, error: '', ...(append ? {} : { items: [], total: 0 }) });
    try {
      const result = await repairExperiences.library(query);
      if (version !== this.requestVersion) return;
      const next = result.items.map(experienceRow);
      const items = append ? [...this.data.items, ...next.filter((n) => !this.data.items.some((old) => old.id === n.id))] : next;
      this.setData({ items, total: result.total, page: result.page, pageSize: result.pageSize, loaded: true });
    } catch (e: any) {
      if (version === this.requestVersion) this.setData({ error: experienceError(e, '文档加载失败，请重试'), loaded: true });
    } finally {
      if (version === this.requestVersion) this.setData({ loading: false, loadingMore: false });
    }
  },
  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
    this.requestVersion++; // 输入期间也禁止上一关键词的请求落地。
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.searchTimer = null; this.onSearch(); }, 300);
  },
  onSearch() {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.setData({ query: this.data.keyword.trim() }); return this.load();
  },
  onClearKeyword() { this.setData({ keyword: '' }); return this.onSearch(); },
  onView(e: WechatMiniprogram.BaseEvent) {
    const view = String(e.currentTarget.dataset.value) as typeof this.data.view;
    if (!this.data.views.some((v) => v.value === view) || view === this.data.view) return;
    this.setData({ view }); return this.load();
  },
  onToggleFilters() { this.setData({ filtersOpen: !this.data.filtersOpen }); },
  onCommunity(e: WechatMiniprogram.PickerChange) {
    const communityIndex = Number(e.detail.value);
    this.setData({ communityIndex, communityId: this.data.communities[communityIndex - 1]?.id || 0, repairType: '', repairTypeIndex: 0 });
    this.syncTypeOptions(); return this.load();
  },
  onRepairType(e: WechatMiniprogram.PickerChange) {
    const repairTypeIndex = Number(e.detail.value);
    this.setData({ repairTypeIndex, repairType: this.data.repairTypes[repairTypeIndex - 1]?.value || '' }); return this.load();
  },
  onLoadMore() { return this.load(true); },
  onReachBottom() { return this.onLoadMore(); },
  async onToggleFavorite(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const item = this.data.items.find((n) => n.id === id);
    if (!item || this.favoriteLocks[id]) return;
    this.favoriteLocks[id] = true;
    try {
      await repairExperiences.setFavorite(id, !item.favorite);
      if (this.data.view === 'favorites') await this.load();
      else this.setData({ items: this.data.items.map((n) => n.id === id ? { ...n, favorite: !item.favorite } : n) });
    } catch (e: any) { wx.showToast({ icon: 'none', title: experienceError(e, '收藏操作失败') }); }
    finally { delete this.favoriteLocks[id]; }
  },
  onOpen(e: WechatMiniprogram.BaseEvent) { wx.navigateTo({ url: `/pages/experience-note/experience-note?id=${Number(e.currentTarget.dataset.id)}` }); },
  onCreate() { if (this.data.canCreate) wx.navigateTo({ url: '/pages/experience-note/experience-note' }); },
});
