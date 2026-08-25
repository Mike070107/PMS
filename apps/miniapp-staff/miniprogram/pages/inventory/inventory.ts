import { inventory, purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import {
  PURCHASE_STATUS_LABELS,
  type MaterialView,
  type PurchaseRequestView,
  type StockView,
  type WarehouseView,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';

/**
 * 库存与采购。
 *
 * 库存这一页和工单里的「添加用料 → 从库存选」是同一件东西的两个入口，
 * 所以**长一个样**：实物照片 + 名称型号 + 编码·类别 + 右侧数量，
 * 上面是搜索框和类别筛选条（共用 app.wxss 的 .sku / .chips，新增入口直接引那一套）。
 * 之前这里是一行纯文字，同一批材料在两处对不上号 —— 办公室在库存页记住的样子，
 * 到了工单里认不出来。
 */

/** 库存一行，字段与工单选料的 WorkOrderStockOption 对齐 */
interface StockRow {
  materialId: number;
  name: string;
  code: string;
  category: string;
  unit: string;
  photoUrl: string;
  qty: number;
  safetyQty: number;
  qtyText: string;
  safetyText: string;
  /** 低于安全库存，列表里要一眼看出来 */
  low: boolean;
}

interface RequestRow extends PurchaseRequestView {
  statusLabel: string;
  amountText: string;
  itemsText: string;
  createdAtText: string;
}

const yuan = (cents: number) => `¥${((cents || 0) / 100).toFixed(2)}`;
const num = (value: string | number) => Number(value ?? 0);

Page({
  data: {
    canView: true,
    roleHint: '',
    loading: true,
    tab: 'stock' as 'stock' | 'purchase',

    warehouses: [] as WarehouseView[],
    warehouseNames: [] as string[],
    warehouseIndex: 0,
    keyword: '',
    onlyLow: false,
    /** 类别筛选条：只列这个仓真有的类别，-1 = 全部 */
    categories: [] as string[],
    categoryIndex: -1,
    stockRows: [] as StockRow[],
    lowCount: 0,

    requests: [] as RequestRow[],
  },

  /** 原始数据放实例上，筛选在本地做 */
  materials: [] as MaterialView[],
  stocks: [] as StockView[],

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const session = await getSession(this);
      if (!session.canViewInventory) {
        this.setData({
          canView: false,
          roleHint: '你的账号没有库存与采购权限。需要材料请在工单详情里提报缺料。',
          stockRows: [],
          requests: [],
        });
        return;
      }
      this.setData({ canView: true });

      const [materials, warehouses, stocks, requests] = await Promise.all([
        inventory.listMaterials(),
        inventory.listWarehouses(),
        inventory.listStocks(),
        purchases.listRequests(),
      ]);
      this.materials = materials;
      this.stocks = stocks;

      this.setData({
        warehouses,
        warehouseNames: ['全部仓库', ...warehouses.map((w) => w.name)],
        requests: requests.map((item) => ({
          ...item,
          statusLabel: PURCHASE_STATUS_LABELS[item.status] || item.status,
          amountText: yuan(item.estTotalCents),
          itemsText: (item.items || []).map((i) => `${i.name} ×${i.qty}`).join('、'),
          createdAtText: formatDateTimeCn(item.createdAt),
        })),
      });
      this.applyStockFilter();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyStockFilter() {
    const materialById = new Map(this.materials.map((item) => [item.id, item]));
    const { warehouseIndex, warehouses, keyword, onlyLow, categoryIndex } = this.data;
    // 0 = 全部仓库，其余按下标错一位对应 warehouses
    const warehouseId = warehouseIndex > 0 ? warehouses[warehouseIndex - 1]?.id : undefined;
    const kw = keyword.trim().toLowerCase();

    // 选「全部仓库」时同一材料跨仓合并，看的是总量
    const merged = new Map<number, StockRow>();
    // 类别筛选只列这个仓真有的类别：列一堆点了没结果的类别等于噪音。
    // 在按类别过滤之前收集，否则一点某个类别，筛选条就只剩这一个了
    const seenCategories: string[] = [];
    const category = categoryIndex >= 0 ? this.data.categories[categoryIndex] : '';

    for (const stock of this.stocks) {
      if (warehouseId && stock.warehouseId !== warehouseId) continue;
      const material = materialById.get(stock.materialId);
      if (!material) continue;
      const categoryName = (material.category || '').trim() || '未分类';
      if (seenCategories.indexOf(categoryName) < 0) seenCategories.push(categoryName);
      if (category && categoryName !== category) continue;
      if (
        kw &&
        ![material.name, material.spec, material.code, material.category, ...(material.aliases || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw)
      ) {
        continue;
      }
      const hit = merged.get(material.id);
      if (hit) {
        hit.qty += num(stock.qty);
        hit.safetyQty += num(stock.safetyQty);
      } else {
        merged.set(material.id, {
          materialId: material.id,
          name: material.spec ? `${material.name} · ${material.spec}` : material.name,
          code: material.code,
          category: categoryName,
          unit: material.unit,
          photoUrl: material.photoUrl || '',
          qty: num(stock.qty),
          safetyQty: num(stock.safetyQty),
          qtyText: '',
          safetyText: '',
          low: false,
        });
      }
    }

    const rows = Array.from(merged.values()).map((row) => ({
      ...row,
      qtyText: `${row.qty}`,
      safetyText: row.safetyQty > 0 ? `安全 ${row.safetyQty}` : '',
      low: row.safetyQty > 0 && row.qty < row.safetyQty,
    }));
    rows.sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));

    // 类别选中后那一项若已不在当前仓里（切仓库导致），退回「全部」，
    // 否则筛选条上高亮着一个不存在的类别，列表却是空的
    const nextCategoryIndex =
      category && seenCategories.indexOf(category) < 0 ? -1 : seenCategories.indexOf(category);

    this.setData({
      categories: seenCategories,
      categoryIndex: category ? nextCategoryIndex : -1,
      stockRows: onlyLow ? rows.filter((row) => row.low) : rows,
      lowCount: rows.filter((row) => row.low).length,
    });
  },

  onSwitchTab(e: WechatMiniprogram.BaseEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  onPickWarehouse(e: WechatMiniprogram.PickerChange) {
    this.setData({ warehouseIndex: Number(e.detail.value) }, () => this.applyStockFilter());
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value }, () => this.applyStockFilter());
  },

  onPickCategory(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ categoryIndex: this.data.categoryIndex === index ? -1 : index }, () =>
      this.applyStockFilter(),
    );
  },

  onToggleLow() {
    this.setData({ onlyLow: !this.data.onlyLow }, () => this.applyStockFilter());
  },

  /** 照片单独点开看大图：光看缩略图分不清 DN50 和 DN75 */
  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = e.currentTarget.dataset.url as string;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },
});
