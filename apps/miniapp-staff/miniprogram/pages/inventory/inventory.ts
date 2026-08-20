import { auth, inventory, purchases } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import {
  PURCHASE_STATUS_LABELS,
  UserRole,
  type MaterialView,
  type PurchaseRequestView,
  type StockView,
  type WarehouseView,
} from '@pms/shared-types';

/** 和后端 /stocks、/purchase-requests 的权限一致：维修工无权 */
const VIEW_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.PURCHASER,
  UserRole.OFFICE,
];

interface StockRow {
  id: number;
  name: string;
  code: string;
  unit: string;
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
      const me = await auth.me();
      if (!VIEW_ROLES.includes(me.role)) {
        this.setData({
          canView: false,
          roleHint: '维修工没有库存与采购权限。需要材料请在工单详情里提报缺料。',
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
    const { warehouseIndex, warehouses, keyword, onlyLow } = this.data;
    // 0 = 全部仓库，其余按下标错一位对应 warehouses
    const warehouseId = warehouseIndex > 0 ? warehouses[warehouseIndex - 1]?.id : undefined;
    const kw = keyword.trim().toLowerCase();

    // 选「全部仓库」时同一材料跨仓合并，看的是总量
    const merged = new Map<number, StockRow>();
    for (const stock of this.stocks) {
      if (warehouseId && stock.warehouseId !== warehouseId) continue;
      const material = materialById.get(stock.materialId);
      if (!material) continue;
      if (
        kw &&
        ![material.name, material.spec, material.code, ...(material.aliases || [])]
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
          id: material.id,
          name: material.spec ? `${material.name} · ${material.spec}` : material.name,
          code: material.code,
          unit: material.unit,
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

    this.setData({
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

  onToggleLow() {
    this.setData({ onlyLow: !this.data.onlyLow }, () => this.applyStockFilter());
  },
});
