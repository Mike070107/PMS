import { inventory, stocktakes } from '@pms/api-client';
import {
  formatDateTimeCn,
  STOCKTAKE_STATUS_LABELS,
  type StocktakeStatus,
  type StocktakeTaskView,
  type WarehouseView,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';
import { guideHandlers } from '../../utils/guide';

interface TaskRow extends StocktakeTaskView {
  statusLabel: string;
  progressText: string;
  progressPercent: number;
  createdText: string;
  actionText: string;
  statusTone: string;
}

const tabs: Array<{ key: string; label: string; statuses?: StocktakeStatus[] }> = [
  { key: 'active', label: '进行中', statuses: ['counting', 'rejected'] },
  { key: 'review', label: '待复核', statuses: ['submitted'] },
  { key: 'done', label: '已完成', statuses: ['approved'] },
];

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    loading: true,
    canEdit: false,
    tab: 'active',
    tabs: tabs.map((item) => ({ ...item, count: 0 })),
    rows: [] as TaskRow[],
    emptyText: '',
    createOpen: false,
    saving: false,
    warehouses: [] as WarehouseView[],
    warehouseNames: [] as string[],
    warehouseIndex: 0,
    title: '',
    errorMsg: '',
  },

  allTasks: [] as StocktakeTaskView[],
  preferredWarehouseId: null as number | null,

  onLoad(query: Record<string, string>) {
    const warehouseId = Number(query.warehouseId);
    this.preferredWarehouseId = Number.isFinite(warehouseId) && warehouseId > 0 ? warehouseId : null;
  },

  onShow() {
    this.syncGuide();
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const [session, tasks, warehouses] = await Promise.all([
        getSession(this),
        stocktakes.list(),
        inventory.listWarehouses({ scope: 'mine' }),
      ]);
      this.allTasks = tasks;
      const preferred = this.preferredWarehouseId
        ? warehouses.findIndex((item) => item.id === this.preferredWarehouseId)
        : -1;
      this.setData({
        canEdit: session.canEditStocktakes,
        warehouses,
        warehouseNames: warehouses.map((item) => item.name),
        warehouseIndex: preferred >= 0 ? preferred : 0,
        tabs: tabs.map((tab) => ({
          ...tab,
          count: tasks.filter((task) => tab.statuses?.includes(task.status)).length,
        })),
      });
      this.applyTab();
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '盘点任务加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyTab() {
    const tab = tabs.find((item) => item.key === this.data.tab) || tabs[0];
    const list = this.allTasks
      .filter((task) => tab.statuses?.includes(task.status))
      .map((task) => this.decorate(task));
    this.setData({
      rows: list,
      emptyText:
        this.data.tab === 'active'
          ? '暂无进行中的盘点任务'
          : this.data.tab === 'review'
            ? '暂无等待复核的盘点任务'
            : '还没有已完成的盘点记录',
    });
  },

  decorate(task: StocktakeTaskView): TaskRow {
    const progressPercent = task.totalCount
      ? Math.min(100, Math.round((task.countedCount / task.totalCount) * 100))
      : 0;
    return {
      ...task,
      statusLabel: STOCKTAKE_STATUS_LABELS[task.status],
      progressText: `已盘 ${task.countedCount} / 共 ${task.totalCount} 项`,
      progressPercent,
      createdText: formatDateTimeCn(task.createdAt),
      actionText:
        task.status === 'counting'
          ? task.countedCount ? '继续盘点' : '开始盘点'
          : task.status === 'rejected'
            ? '按退回意见修改'
            : task.status === 'submitted'
              ? '查看并复核'
              : '查看盘点结果',
      statusTone:
        task.status === 'submitted'
          ? 'review'
          : task.status === 'rejected'
            ? 'reject'
            : task.status === 'approved'
              ? 'done'
              : 'active',
    };
  },

  onTab(e: WechatMiniprogram.BaseEvent) {
    this.setData({ tab: String(e.currentTarget.dataset.key) }, () => this.applyTab());
  },

  onOpenTask(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const task = this.allTasks.find((item) => item.id === id);
    if (!task) return;
    const page = this.data.canEdit && (task.status === 'counting' || task.status === 'rejected')
      ? 'stocktake-count'
      : 'stocktake-review';
    wx.navigateTo({ url: `/pages/${page}/${page}?id=${id}` });
  },

  onNew() {
    if (!this.data.canEdit) {
      return wx.showToast({ icon: 'none', title: '你的角色没有盘点操作权限' });
    }
    if (!this.data.warehouses.length) {
      return wx.showToast({ icon: 'none', title: '当前范围还没有可盘点的仓库' });
    }
    this.setData({ createOpen: true, title: '', errorMsg: '' });
  },

  onCloseCreate() {
    this.setData({ createOpen: false, errorMsg: '' });
  },

  onWarehouse(e: WechatMiniprogram.PickerChange) {
    this.setData({ warehouseIndex: Number(e.detail.value) });
  },

  onTitle(e: WechatMiniprogram.Input) {
    this.setData({ title: e.detail.value });
  },

  async onCreate() {
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    if (!warehouse) return this.setData({ errorMsg: '请选择盘点仓库' });
    this.setData({ saving: true, errorMsg: '' });
    try {
      const detail = await stocktakes.create({
        warehouseId: warehouse.id,
        title: this.data.title.trim() || undefined,
      });
      this.setData({ createOpen: false });
      wx.navigateTo({ url: `/pages/stocktake-count/stocktake-count?id=${detail.id}` });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '创建盘点任务失败' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onScan() {
    const active = this.allTasks.filter((item) => ['counting', 'rejected'].includes(item.status));
    if (!active.length) return wx.showToast({ icon: 'none', title: '请先新建盘点任务' });
    if (active.length > 1) return wx.showToast({ icon: 'none', title: '请先进入要盘点的任务' });
    const result = await wx.scanCode({ scanType: ['barCode', 'qrCode'] }).catch(() => null);
    if (!result?.result) return;
    wx.navigateTo({
      url: `/pages/stocktake-count/stocktake-count?id=${active[0].id}&code=${encodeURIComponent(result.result)}`,
    });
  },

  noop() {},
});
