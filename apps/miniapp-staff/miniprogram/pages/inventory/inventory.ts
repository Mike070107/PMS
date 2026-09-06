import { inventory, purchases, upload } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import {
  MATERIAL_UNITS,
  PURCHASE_STATUS_LABELS,
  PurchaseRequestStatus,
  type MaterialView,
  type PurchaseRequestView,
  type StockView,
  type WarehouseView,
} from '@pms/shared-types';
import { getSession, type StaffSession } from '../../utils/session';
import { setTabBadge, setTabBarHidden, syncTabBar } from '../../utils/tabbar';
import { refreshTabBadges } from '../../utils/badges';
import { guideHandlers } from '../../utils/guide';

/**
 * 材料与库存（办公室一侧的常驻一屏）。
 *
 * 为什么把原来的「材料 SKU 库」和「库存」合成一页：那是同一批东西的两份清单 ——
 * 一份带库存量、一份带成本，行长得几乎一样。分成两页的后果是
 * 「先在 SKU 库里找到它，再去库存页找一遍看还有几个」，而点开一条 SKU 弹出来的
 * 又是列表上已经写着的那几行字，白点一下。
 *
 * 现在：**一屏就是库存**，只列出当前仓加入、入库、领用或报缺料过的 SKU；
 * 数量归零后仍显示。全局 SKU 只在「材料 SKU」和工单选料搜索中展开，不再铺满每个仓。
 * 点开一行给的是列表上没有的东西 —— 分仓库存明细、别名、参数、成本，不再重复一遍。
 */

/** 一行 = 一条 SKU + 它在当前仓（或全部仓合计）的库存 */
interface SkuRow {
  materialId: number;
  /** 「PVC 管 · DN50」 */
  title: string;
  name: string;
  spec: string;
  code: string;
  category: string;
  unit: string;
  photoUrl: string;
  /** 全部实物照片（最多 4 张）：点开大图要把整组交给 previewImage 才能左右滑 */
  photoUrls: string[];
  qty: number;
  safetyQty: number;
  qtyText: string;
  metaText: string;
  low: boolean;
  /** 有未完成的工单缺料需求，与安全库存是两套口径 */
  workShortage: boolean;
  enabled: boolean;
  defaultCostCents: number;
  costText: string;
  aliases: string[];
  aliasText: string;
  params: string;
  /** 缺哪些信息，写成「照片、类别」贴在行里 */
  missingText: string;
  incomplete: boolean;
}

interface RequestRow extends PurchaseRequestView {
  statusLabel: string;
  amountText: string;
  itemsText: string;
  createdAtText: string;
  /** 卡片上先给前 3 行（带缩略图），全部明细进详情页看 */
  lines: Array<{ lineId: string; name: string; spec: string; qty: number; unit: string; note: string; photoUrl: string }>;
  moreCount: number;
  sourceText: string;
  applicantText: string;
  /** 还在办公室汇总且本人有材料编辑权：详情页里能改能补图 */
  editable: boolean;
}

/** 列表卡片上的明细摘要：最多 3 行，缩略图优先用维修工拍的样本 / 材料库主图 */
function toRequestRow(item: PurchaseRequestView, canEditMaterials: boolean): RequestRow {
  const items = item.items || [];
  return {
    ...item,
    statusLabel: PURCHASE_STATUS_LABELS[item.status] || item.status,
    amountText: yuan(item.estTotalCents),
    itemsText: items.map((i) => `${i.name} ×${i.qty}`).join('、'),
    createdAtText: formatDateTimeCn(item.createdAt),
    lines: items.slice(0, 3).map((line, index) => ({
      lineId: line.lineId || `${item.id}-${index + 1}`,
      name: line.name,
      spec: line.spec || '',
      qty: line.qty,
      unit: line.unit || '',
      note: line.note || '',
      photoUrl: line.photoUrl || (line.photoUrls && line.photoUrls[0]) || '',
    })),
    moreCount: Math.max(0, items.length - 3),
    sourceText: item.sourceWorkOrderNos?.length
      ? `来自工单 ${item.sourceWorkOrderNos.join('、')}`
      : item.workOrderId
        ? `来自工单 ${item.workOrderNo || '未知工单'}`
        : '办公室手工申请',
    applicantText: item.applicantName || '未知申请人',
    editable: item.status === PurchaseRequestStatus.OFFICE_REVIEW && canEditMaterials,
  };
}

interface FormState {
  id: number | null;
  name: string;
  spec: string;
  category: string;
  unit: string;
  costYuan: string;
  aliases: string;
  params: string;
  photoUrls: string[];
  enabled: boolean;
}

type InventoryMetric = '' | 'work_shortage' | 'low_stock' | 'safety_out';

interface InventoryFilterSnapshot {
  keyword: string;
  onlyStocked: boolean;
  onlyLow: boolean;
  onlyIncomplete: boolean;
  categoryIndex: number;
  scrollTop: number;
}

const ACTIVE_SHORTAGE_STATUSES = new Set<PurchaseRequestStatus>([
  PurchaseRequestStatus.DRAFT,
  PurchaseRequestStatus.OFFICE_REVIEW,
  PurchaseRequestStatus.MANAGER_REVIEW,
  PurchaseRequestStatus.PURCHASER_REVIEW,
  PurchaseRequestStatus.APPROVED,
  // 驳回只表示需要修改后重提，工单需要的材料并没有凭空消失。
  PurchaseRequestStatus.REJECTED,
]);

/** 一条 SKU 最多几张实物照片，和后端 MATERIAL_PHOTO_LIMIT 是一套账 */
const PHOTO_LIMIT = 4;

const emptyForm = (): FormState => ({
  id: null,
  name: '',
  spec: '',
  category: '',
  unit: '个',
  costYuan: '',
  aliases: '',
  params: '',
  photoUrls: [],
  enabled: true,
});

/** 老数据只有单图字段，新数据有数组；取用一律走这里 */
function photoList(item: { photoUrl?: string | null; photoUrls?: string[] | null }): string[] {
  const list = (item.photoUrls || []).filter(Boolean) as string[];
  if (list.length) return list;
  return item.photoUrl ? [item.photoUrl] : [];
}

const yuan = (cents: number) => `¥${((cents || 0) / 100).toFixed(2)}`;
const num = (value: string | number) => Number(value ?? 0);
/** 材料名称按中文拼音 / 英文 A-Z；名称相同再按型号、编码保证顺序稳定。 */
const compareSkuName = (a: Pick<SkuRow, 'name' | 'spec' | 'code'>, b: Pick<SkuRow, 'name' | 'spec' | 'code'>) =>
  a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  || a.spec.localeCompare(b.spec, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  || a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/**
 * 「没填完整」的判定只在这里写一次。
 *
 * 挑这三样是因为它们决定这条 SKU 在别处还能不能用：
 * 没照片 → 维修工在库存里认不出 DN50 和 DN75；
 * 没类别 → 编码前缀、类别筛选都对不上；
 * 没默认成本 → 采购申请估不出金额。
 * 型号、别名、参数属于锦上添花，缺了不算残缺，不然整库都是红标，等于没标。
 */
/**
 * 进页面默认选哪个仓（picker 下标：0 = 全部仓库，其余错一位对应 warehouses）。
 * 依据是本人角色范围对应的管理处（session.me.access.offices，由角色的数据范围算出来）
 * 对上仓库档案里的「所属管理处」：
 *   · 范围只有一个管理处（管理处专属维修工）→ 该管理处的第一个启用仓
 *   · 全公司范围（总公司维修工 / 办公室 / 采购）→ 全部仓库
 *   · 对不上（管理处还没建仓）→ 全部仓库
 */
function defaultWarehouseIndex(session: StaffSession, warehouses: WarehouseView[]): number {
  // smart 工种的专属仓由后端标 preferred；即使角色是全公司范围，也不能再落到「全部仓库」。
  const preferred = warehouses.findIndex((warehouse) => warehouse.enabled && warehouse.preferred);
  if (preferred >= 0) return preferred + 1;
  const access = session.me?.access;
  if (!access || access.scopeAll) return 0;
  // 列表已经是服务端按范围过滤过的（自己管理处的仓排最前），第一个挂了管理处的就是默认仓
  const index = warehouses.findIndex((w) => w.enabled && !!w.officeId);
  return index >= 0 ? index + 1 : 0;
}

function missingFields(item: MaterialView): string[] {
  const missing: string[] = [];
  if (!photoList(item).length) missing.push('照片');
  if (!item.category) missing.push('类别');
  if (!item.defaultCostCents) missing.push('成本');
  return missing;
}

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    canView: true,
    canEdit: false,
    roleHint: '',
    loading: true,
    /** 首次加载完成后为 true：默认仓只在第一次进来时按管理处定，之后尊重用户切过的 */
    loaded: false,
    /** 管理处范围的人一个仓都看不到时的说明 */
    noWarehouseHint: '',
    tab: 'stock' as 'stock' | 'sku' | 'purchase',
    /** 「库存 / 采购申请」两格：app:inventory。只勾了材料 SKU 的角色看不到它们 */
    canViewStock: true,
    /** 独立的库存盘点入口，不跟库存/采购权限捆绑。 */
    canViewStocktake: false,
    /** 「材料 SKU」这一格由角色矩阵的 app:materials 决定，没勾的人连这个 tab 都看不到 */
    canViewSku: false,
    canEditSku: false,
    skuKeyword: '',
    skuRows: [] as SkuRow[],
    skuCategories: [] as string[],
    skuCategoryIndex: -1,

    warehouses: [] as WarehouseView[],
    warehouseNames: [] as string[],
    warehouseIndex: 0,
    keyword: '',
    /** 默认展示本仓管理过的全部材料，用完归零也不隐藏 */
    onlyStocked: false,
    /** 只因为「仅显示有货」而被藏起来的条数，列表上写清楚，别让人以为系统里没这东西 */
    hiddenByStocked: 0,
    onlyLow: false,
    /** 只看没填完整的：办公室补 SKU 时先把这一堆清掉 */
    onlyIncomplete: false,
    incompleteCount: 0,
    warehouseIncompleteCount: 0,
    lowCount: 0,
    overviewWorkShortageCount: 0,
    overviewLowCount: 0,
    overviewOutCount: 0,
    /** 点击概览数字后进入的聚焦清单 */
    activeMetric: '' as InventoryMetric,
    activeMetricTitle: '',
    activeMetricHint: '',
    selectedWarehouseName: '全部仓库',
    /** 类别筛选条：只列真有的类别，-1 = 全部 */
    categories: [] as string[],
    categoryIndex: -1,
    rows: [] as SkuRow[],

    requests: [] as RequestRow[],

    // ---- 详情 / 编辑面板 ----
    detailOpen: false,
    detail: null as SkuRow | null,
    /** 这条 SKU 在各仓的存量，列表上没有，点开才值得看 */
    detailStocks: [] as Array<{ name: string; qtyText: string; low: boolean }>,
    editorOpen: false,
    saving: false,
    uploading: false,
    form: emptyForm(),
    units: MATERIAL_UNITS,
    /** 类别档案由服务端给（后台可增删改），不再用写死的常量 —— 两端必须是同一份清单 */
    formCategories: [] as string[],
    unitIndex: 0,
    formCategoryIndex: -1,
    errors: { name: '', unit: '' },
  },

  /** 原始数据放实例上，筛选在本地做，翻来翻去不用每次都请求 */
  materials: [] as MaterialView[],
  stocks: [] as StockView[],
  /** 本人看得见的仓 id 集合（服务端按范围过滤后的）；「全部仓库」合计只算这些 */
  visibleWarehouseIds: undefined as Set<number> | undefined,
  /** 进入统计明细前的筛选和滚动位置，返回时原样恢复 */
  metricReturnState: null as InventoryFilterSnapshot | null,
  pageScrollTop: 0,

  onShow() {
    this.syncGuide();
    syncTabBar(this, 'materials');
    this.load();
    // 底部其它几格的角标一起对准（这一页自己那格由 load 按「还有几条要补」设）
    refreshTabBadges(this);
  },

  /**
   * 下拉刷新连权限一起重新拿 —— 后台刚勾上「材料 SKU 库-编辑」，
   * 不强制刷新的话这一屏还是没有「编辑 SKU」，得杀掉小程序重进才认。
   */
  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onPageScroll(e: { scrollTop: number }) {
    this.pageScrollTop = Number(e.scrollTop) || 0;
  },

  /** 给弹层遮罩的 catchtouchmove 用：吞掉滑动，别让底下的列表跟着滚 */
  noop() {},

  async load(refreshSession = false) {
    this.setData({ loading: true });
    try {
      const session = await getSession(this, refreshSession);
      // 只勾了「材料 SKU 库」的角色也该进得来 —— 他进来看到的就只有那一个 tab
      if (!session.canViewMaterials && !session.canViewInventory && !session.canViewSku && !session.canViewStocktakes) {
        this.setData({
          canView: false,
          roleHint: '你的账号没有材料与库存权限。需要材料请在工单详情里提报缺料，由办公室汇总。',
          rows: [],
          requests: [],
        });
        return;
      }
      const canViewStock = session.canViewMaterials || session.canViewInventory;
      this.setData({
        canView: true,
        canEdit: session.canEditMaterials,
        canViewStock,
        canViewStocktake: session.canViewStocktakes,
        // 看不到库存那一格的人（只勾了材料 SKU）默认落在 SKU 页，
        // 否则进来是一片空白，还以为坏了
        tab: canViewStock ? this.data.tab : 'sku',
        canViewSku: session.canViewSku,
        // 库存页那个「编辑 SKU」保留旧口径（app:inventory 的改材料），
        // 再并上新的这一格 —— 新增一格权限不该把老角色已有的能力拿走
        canEditSku: session.canEditSku || session.canEditMaterials,
      });

      // 只授权盘点的人只需要上面的“库存盘点”入口；不要继续请求库存、采购和 SKU
      // 接口，否则这些独立权限会因为后续接口 403 而整页显示“加载失败”。
      if (!canViewStock && !session.canViewSku) return;

      const [materials, warehouses, stocks, requests, categories] = await Promise.all([
        inventory.listMaterials(),
        // 只拿本人范围能看的仓：自己管理处的排前面，公司级的在后；别的管理处的仓不出现
        inventory.listWarehouses({ scope: 'mine' }),
        inventory.listStocks(),
        purchases.listRequests(),
        // 启用中的类别才让选；停用的老材料照常显示，只是不能再往里新建
        inventory.listMaterialCategories().catch(() => []),
      ]);
      this.materials = materials;
      this.stocks = stocks;
      this.visibleWarehouseIds = new Set(warehouses.map((w) => w.id));
      // 管理处范围的人却一个仓都没有：说清是没建仓，不是坏了，也别让人以为自己没权限
      const noWarehouseHint =
        !warehouses.length && session.me?.access && !session.me.access.scopeAll
          ? '你所属的管理处还没有仓库，请办公室在后台「库存与采购 → 基础资料 → 仓库档案」里给管理处建仓（新建管理处会自动带一个同名仓）。'
          : '';

      const incompleteCount = materials.filter(
        (item) => item.enabled && missingFields(item).length > 0,
      ).length;

      // 默认仓：智能化维修工先选工种专属仓；其他人按角色范围对应的管理处挑。
      // 只有第一次进来才定，之后尊重用户手动切换；非智能化的全公司角色保持「全部仓库」
      const warehouseIndex = this.data.loaded
        ? Math.min(this.data.warehouseIndex, warehouses.length)
        : defaultWarehouseIndex(session, warehouses);
      this.setData({
        formCategories: categories.filter((item) => item.enabled).map((item) => item.label),
        warehouses,
        warehouseNames: ['全部仓库', ...warehouses.map((w) => w.name)],
        warehouseIndex,
        loaded: true,
        noWarehouseHint,
        incompleteCount,
        requests: requests.map((item) => toRequestRow(item, !!session.canEditMaterials)),
      });
      // 角标 = 还有几条要补：办公室不用点进来才知道有没有活
      setTabBadge(this, 'materials', session.canEditMaterials ? incompleteCount : 0);
      this.applyFilter();
      this.applySkuFilter();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 采购申请卡片 → 详情页（全部照片、改明细、补图、提交 / 重新打开） */
  onOpenRequest(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: `/pages/purchase-request/purchase-request?id=${id}` });
  },

  /** 某条 SKU 在某个仓（warehouseId 为空 = 全部仓合计）的存量 */
  sumStock(materialId: number, warehouseId?: number) {
    let qty = 0;
    let safetyQty = 0;
    let found = false;
    // 「全部仓库」只合计看得见的仓：别的管理处的库存不该混进本人的数里
    const visible = this.visibleWarehouseIds as Set<number> | undefined;
    for (const stock of this.stocks as StockView[]) {
      if (stock.materialId !== materialId) continue;
      if (warehouseId && stock.warehouseId !== warehouseId) continue;
      if (!warehouseId && visible && !visible.has(stock.warehouseId)) continue;
      qty += num(stock.qty);
      safetyQty += num(stock.safetyQty);
      found = true;
    }
    return { qty, safetyQty, found };
  },

  /**
   * 一条 SKU → 列表里的一行。**库存页和材料 SKU 页共用这一个** ——
   * 同一批材料在两处长得不一样，办公室在这边记住的东西，维修工在那边认不出来。
   */
  buildRow(
    material: MaterialView,
    qty: number,
    safetyQty: number,
    workShortage = false,
  ): SkuRow {
    const categoryName = (material.category || '').trim() || '未分类';
    const aliases = material.aliases || [];
    const missing = missingFields(material);
    return {
      materialId: material.id,
      title: material.spec ? `${material.name} · ${material.spec}` : material.name,
      name: material.name,
      spec: material.spec || '',
      code: material.code,
      category: categoryName,
      unit: material.unit,
      photoUrl: photoList(material)[0] || '',
      photoUrls: photoList(material),
      qty,
      safetyQty,
      // 仓里一件没有时写「无货」而不是 0：0 看着像「没统计到」
      qtyText: qty > 0 ? String(qty) : '无货',
      metaText: [material.code, categoryName, safetyQty > 0 ? `安全 ${safetyQty}` : '']
        .filter(Boolean)
        .join(' · '),
      low: safetyQty > 0 && qty <= safetyQty,
      workShortage,
      enabled: material.enabled,
      defaultCostCents: material.defaultCostCents,
      costText: material.defaultCostCents ? yuan(material.defaultCostCents) : '未填',
      aliases,
      aliasText: aliases.join('、'),
      params: material.params || '',
      missingText: missing.join('、'),
      incomplete: missing.length > 0,
    };
  },

  /**
   * 材料 SKU 页的筛选。和库存页最大的不同：**这里是材料档案，不看库存** ——
   * 无货的、停用的都要列出来，那正是来这一页要找的东西
   * （库存页默认「仅显示有货」，建过档没入库的在那边根本不出现）。
   */
  applySkuFilter() {
    const kw = this.data.skuKeyword.trim().toLowerCase();
    const category =
      this.data.skuCategoryIndex >= 0 ? this.data.skuCategories[this.data.skuCategoryIndex] : '';
    const seen: string[] = [];
    const rows: SkuRow[] = [];
    for (const material of this.materials as MaterialView[]) {
      const categoryName = (material.category || '').trim() || '未分类';
      if (seen.indexOf(categoryName) < 0) seen.push(categoryName);
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
      const { qty, safetyQty } = this.sumStock(material.id);
      rows.push(this.buildRow(material, qty, safetyQty));
    }
    rows.sort(compareSkuName);
    const nextCategoryIndex = category ? seen.indexOf(category) : -1;
    this.setData({ skuCategories: seen, skuCategoryIndex: nextCategoryIndex, skuRows: rows });
  },

  /**
   * 当前仓库需要处理的工单缺料 SKU。
   * 已合并的原单和已完成采购不再统计；驳回单仍是未解决缺料。合并后的主单保留了
   * sourceWorkOrderId / warehouseId，所以仍会正常命中。
   */
  workShortageMaterialIds(warehouseId: number | undefined, managedMaterialIds: Set<number>) {
    const ids = new Set<number>();
    for (const request of this.data.requests as RequestRow[]) {
      if (!ACTIVE_SHORTAGE_STATUSES.has(request.status)) continue;
      for (const item of request.items || []) {
        const fromWorkOrder = !!(item.sourceWorkOrderId || request.workOrderId);
        const materialId = Number(item.materialId || 0);
        if (!fromWorkOrder || !materialId) continue;
        const itemWarehouseId = Number(item.warehouseId || 0);
        if (warehouseId && itemWarehouseId && itemWarehouseId !== warehouseId) continue;
        if (!managedMaterialIds.has(materialId)) continue;
        // 历史缺料数据没有 warehouseId：只在该 SKU 本来就属于当前仓时才纳入，
        // 不把全公司的旧申请都算到每一个仓头上。
        ids.add(materialId);
      }
    }
    return ids;
  },

  onSkuKeyword(e: WechatMiniprogram.Input) {
    this.setData({ skuKeyword: e.detail.value }, () => this.applySkuFilter());
  },

  onPickSkuCategory(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData(
      { skuCategoryIndex: this.data.skuCategoryIndex === index ? -1 : index },
      () => this.applySkuFilter(),
    );
  },

  applyFilter() {
    const {
      warehouseIndex,
      warehouses,
      keyword,
      onlyLow,
      onlyIncomplete,
      onlyStocked,
      categoryIndex,
      activeMetric,
    } = this.data;
    // 0 = 全部仓库，其余按下标错一位对应 warehouses
    const warehouseId = warehouseIndex > 0 ? warehouses[warehouseIndex - 1]?.id : undefined;
    const kw = keyword.trim().toLowerCase();
    const category = categoryIndex >= 0 ? this.data.categories[categoryIndex] : '';

    // 库存页的数据源是「仓库材料清单」（stocks 记录），不是全部 SKU。
    // qty=0 的记录仍然 found=true，所以用完后依旧展示；只建了 SKU、从没加入这个仓的不展示。
    const managed = (this.materials as MaterialView[])
      .map((material) => ({ material, stock: this.sumStock(material.id, warehouseId) }))
      .filter((item) => item.stock.found);
    const managedMaterialIds = new Set(managed.map((item) => item.material.id));
    const workShortageIds = this.workShortageMaterialIds(warehouseId, managedMaterialIds);

    // 页头概览不受搜索和类别筛选影响；安全库存为 0 就是按需采购，不发任何补库预警。
    let overviewLowCount = 0;
    let overviewOutCount = 0;
    let warehouseIncompleteCount = 0;
    for (const { material, stock } of managed) {
      if (!material.enabled) continue;
      const { qty, safetyQty } = stock;
      if (missingFields(material).length) warehouseIncompleteCount += 1;
      if (safetyQty > 0 && qty <= safetyQty) overviewLowCount += 1;
      if (safetyQty > 0 && qty <= 0) overviewOutCount += 1;
    }

    // 类别筛选也只从当前仓真正管理的材料中产生。
    const seenCategories: string[] = [];
    const rows: SkuRow[] = [];
    let hiddenByStocked = 0;

    for (const { material, stock } of managed) {
      const categoryName = (material.category || '').trim() || '未分类';
      if (material.enabled) {
        if (seenCategories.indexOf(categoryName) < 0) seenCategories.push(categoryName);
      }
      const { qty, safetyQty } = stock;
      const missing = missingFields(material);
      const low = safetyQty > 0 && qty <= safetyQty;

      if (activeMetric) {
        if (activeMetric === 'work_shortage' && !workShortageIds.has(material.id)) continue;
        if (activeMetric === 'low_stock' && !low) continue;
        if (activeMetric === 'safety_out' && !(safetyQty > 0 && qty <= 0)) continue;
      } else {
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
        if (onlyLow && !low) continue;
        if (onlyIncomplete && !missing.length) continue;
        if (onlyStocked && qty <= 0) {
          hiddenByStocked += 1;
          continue;
        }
      }

      rows.push(this.buildRow(material, qty, safetyQty, workShortageIds.has(material.id)));
    }

    // 库存与材料 SKU 两格统一按材料名称 A-Z；低库存、资料不全仍保留醒目标记和筛选。
    rows.sort(compareSkuName);

    // 选中的类别若已不在（切仓库/搜索导致）就退回「全部」，
    // 否则筛选条上高亮着一个不存在的类别，列表却是空的
    const nextCategoryIndex = category ? seenCategories.indexOf(category) : -1;

    this.setData({
      categories: seenCategories,
      categoryIndex: nextCategoryIndex,
      rows,
      hiddenByStocked,
      lowCount: rows.filter((row) => row.low).length,
      overviewWorkShortageCount: workShortageIds.size,
      overviewLowCount,
      overviewOutCount,
      warehouseIncompleteCount,
      selectedWarehouseName: this.data.warehouseNames[warehouseIndex] || '全部仓库',
    });
  },

  /** 统计卡片数字可点：进入对应材料清单，并保存原来的筛选与滚动位置。 */
  onOpenMetric(e: WechatMiniprogram.BaseEvent) {
    const metric = String(e.currentTarget.dataset.metric || '') as InventoryMetric;
    if (!metric) return;
    if (!this.data.activeMetric) {
      this.metricReturnState = {
        keyword: this.data.keyword,
        onlyStocked: this.data.onlyStocked,
        onlyLow: this.data.onlyLow,
        onlyIncomplete: this.data.onlyIncomplete,
        categoryIndex: this.data.categoryIndex,
        scrollTop: this.pageScrollTop,
      };
    }
    const copy = {
      work_shortage: {
        title: '工单缺料',
        hint: '已有工单需要、当前正在采购处理的材料',
      },
      low_stock: {
        title: '达到或低于安全库存',
        hint: '仅统计安全库存大于 0，且当前可用数量已到达或低于补货线的常备材料',
      },
      safety_out: {
        title: '常备料无货',
        hint: '安全库存大于 0，但当前库存已经为 0',
      },
    }[metric];
    if (!copy) return;
    this.setData(
      {
        activeMetric: metric,
        activeMetricTitle: copy.title,
        activeMetricHint: copy.hint,
        keyword: '',
        onlyStocked: false,
        onlyLow: false,
        onlyIncomplete: false,
        categoryIndex: -1,
      },
      () => {
        this.applyFilter();
        wx.pageScrollTo({ scrollTop: 0, duration: 180 });
      },
    );
  },

  onCloseMetric() {
    const previous = this.metricReturnState;
    this.metricReturnState = null;
    this.setData(
      {
        activeMetric: '',
        activeMetricTitle: '',
        activeMetricHint: '',
        keyword: previous?.keyword ?? '',
        onlyStocked: previous?.onlyStocked ?? false,
        onlyLow: previous?.onlyLow ?? false,
        onlyIncomplete: previous?.onlyIncomplete ?? false,
        categoryIndex: previous?.categoryIndex ?? -1,
      },
      () => {
        this.applyFilter();
        wx.pageScrollTo({ scrollTop: previous?.scrollTop ?? 0, duration: 180 });
      },
    );
  },

  onSwitchTab(e: WechatMiniprogram.BaseEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  onPickWarehouse(e: WechatMiniprogram.BaseEvent) {
    this.setData({ warehouseIndex: Number(e.currentTarget.dataset.index) }, () => this.applyFilter());
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  onPickCategory(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ categoryIndex: this.data.categoryIndex === index ? -1 : index }, () =>
      this.applyFilter(),
    );
  },

  onToggleLow() {
    const onlyLow = !this.data.onlyLow;
    // 要补货的多半是没货的：开这个开关时把「仅显示有货」放开，否则列表看着是空的
    this.setData({ onlyLow, onlyIncomplete: false, onlyStocked: onlyLow ? false : this.data.onlyStocked }, () =>
      this.applyFilter(),
    );
  },

  onToggleIncomplete() {
    const onlyIncomplete = !this.data.onlyIncomplete;
    this.setData({ onlyIncomplete, onlyLow: false, onlyStocked: onlyIncomplete ? false : this.data.onlyStocked }, () =>
      this.applyFilter(),
    );
  },

  onToggleStocked(e: WechatMiniprogram.CheckboxGroupChange) {
    this.setData({ onlyStocked: (e.detail.value || []).indexOf('1') >= 0 }, () => this.applyFilter());
  },

  /**
   * 照片点开看大图。**urls 一定要给整组**，只给当前这一张就滑不动 ——
   * 一条 SKU 有正面/侧面/铭牌/包装四张，光看一张分不清 DN50 和 DN75。
   */
  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    const list = urls.length ? urls : url ? [url] : [];
    if (!list.length) return;
    wx.previewImage({ current: url || list[0], urls: list });
  },

  /** 「仅显示有货」挡住了东西时，一键放开（提示条上点） */
  onShowHidden() {
    this.setData({ onlyStocked: false }, () => this.applyFilter());
  },

  // ---------------- 详情：只给列表上没有的东西 ----------------

  onOpenDetail(e: WechatMiniprogram.BaseEvent) {
    const list = e.currentTarget.dataset.from === 'sku' ? this.data.skuRows : this.data.rows;
    const row = list[Number(e.currentTarget.dataset.index)];
    if (!row) return;
    const byWarehouse = (this.data.warehouses as WarehouseView[])
      .map((warehouse) => {
        const { qty, safetyQty, found } = this.sumStock(row.materialId, warehouse.id);
        return {
          name: warehouse.name,
          qtyText: qty > 0 ? `${qty}${row.unit}` : found ? '无货' : '未入过库',
          low: safetyQty > 0 && qty <= safetyQty,
        };
      })
      // 有过库存记录的排前面，没入过库的沉底
      .sort((a, b) => Number(b.qtyText !== '未入过库') - Number(a.qtyText !== '未入过库'));
    this.setData({ detailOpen: true, detail: row, detailStocks: byWarehouse });
    this.syncSheetTabBar();
  },

  /**
   * 弹层开着就把胶囊 tabBar 藏起来。
   *
   * 只靠 z-index 不行：胶囊是自定义 tabBar，微信把它渲染在页面之上的另一层，
   * 不参与页面里的 z-index 比较（2026-08-31 实测，弹层排到 200 照样被压住）。
   * 每次开关弹层后调一次，两个弹层叠着时不会被误放出来 —— setData 之后
   * this.data 已经是新值，所以直接在下一行调即可。
   */
  syncSheetTabBar() {
    setTabBarHidden(this, !!(this.data.detailOpen || this.data.editorOpen));
  },

  onCloseDetail() {
    this.setData({ detailOpen: false });
    this.syncSheetTabBar();
  },

  // ---------------- 新增 / 编辑 SKU ----------------

  /**
   * 「+ 新增」走的是**入库向导**，不是直接弹建档表单。
   *
   * 直接建档的老流程有两个坑：一是不先查一遍就填，填到一半才被「已存在同名同型号」
   * 挡回来；二是建完只有一条光杆 SKU，一件库存都没有，在这一屏（默认「仅显示有货」）
   * 里当场就看不见了，人会以为没建上、再建一次。
   * 向导按「先找 → 找不到再建 → 当场入库」的顺序走，两个坑都不成立。
   */
  onCreate() {
    wx.navigateTo({ url: '/pages/material-inbound/material-inbound' });
  },

  /** 现场拿手机盘点：带上当前选中的仓，进入任务页后直接作为新任务默认仓。 */
  onStocktake() {
    const warehouse =
      this.data.warehouseIndex > 0
        ? this.data.warehouses[this.data.warehouseIndex - 1]
        : undefined;
    wx.navigateTo({
      url: `/pages/stocktake/stocktake${warehouse ? `?warehouseId=${warehouse.id}` : ''}`,
    });
  },

  /** 行内的「编辑」按钮和详情面板底部的「编辑」都走这里 */
  onEdit(e: WechatMiniprogram.BaseEvent) {
    const raw = e.currentTarget.dataset.index;
    // 库存页和材料 SKU 页是两份列表，下标各算各的，取错了会编辑到别的材料
    const list = e.currentTarget.dataset.from === 'sku' ? this.data.skuRows : this.data.rows;
    const row = raw === undefined || raw === '' ? this.data.detail : list[Number(raw)];
    if (!row) return;
    this.setData({
      detailOpen: false,
      editorOpen: true,
      form: {
        id: row.materialId,
        name: row.name,
        spec: row.spec,
        category: row.category === '未分类' ? '' : row.category,
        unit: row.unit,
        costYuan: row.defaultCostCents ? String(row.defaultCostCents / 100) : '',
        aliases: row.aliases.join('、'),
        params: row.params,
        photoUrls: row.photoUrls,
        enabled: row.enabled,
      },
      // 历史上手填过的单位不在常用表里时，选择器停在第一项，保存时仍按表单里的值走
      unitIndex: Math.max(0, MATERIAL_UNITS.indexOf(row.unit)),
      formCategoryIndex:
        row.category && row.category !== '未分类'
          ? this.data.formCategories.indexOf(row.category)
          : -1,
      errors: { name: '', unit: '' },
    });
    // 列表行上的「编辑 SKU」是从没有弹层的状态直接进编辑器的，这一句不能省
    this.syncSheetTabBar();
  },

  onCloseEditor() {
    this.setData({ editorOpen: false });
    this.syncSheetTabBar();
  },

  onFormInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as keyof FormState;
    this.setData({ [`form.${field}`]: e.detail.value, [`errors.${field}`]: '' });
  },

  onFormUnit(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ unitIndex: index, 'form.unit': MATERIAL_UNITS[index], 'errors.unit': '' });
  },

  onFormCategory(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ formCategoryIndex: index, 'form.category': this.data.formCategories[index] });
  },

  onToggleEnabled(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  /**
   * 现场拍实物照，比在电脑上传方便得多 —— 补照片是这一屏最常干的事。
   * 最多 4 张（正面 / 侧面 / 铭牌 / 包装），一次可多选，剩几个位就只让选几张。
   */
  async onChoosePhoto() {
    if (this.data.uploading) return;
    const current = this.data.form.photoUrls || [];
    const room = PHOTO_LIMIT - current.length;
    if (room <= 0) {
      return wx.showToast({ icon: 'none', title: `最多 ${PHOTO_LIMIT} 张照片` });
    }
    const res = await wx
      // sizeType 必须显式写：不写是拿微信的默认值，机型/版本不同可能给原图。
      // 上传时还会再兜一道压缩（api-client 的 compressImageIfNeeded）
      .chooseMedia({
        count: room,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed'],
      })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setData({
        'form.photoUrls': [...current, ...uploaded.map((item) => item.publicUrl)].slice(0, PHOTO_LIMIT),
      });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const next = (this.data.form.photoUrls || []).filter((_, i) => i !== index);
    this.setData({ 'form.photoUrls': next });
  },

  async onSave() {
    const form = this.data.form;
    const errors = {
      name: form.name.trim() ? '' : '请填写材料名称',
      unit: form.unit.trim() ? '' : '请选择单位',
    };
    this.setData({ errors });
    if (errors.name || errors.unit) return;

    const cost = Number(form.costYuan);
    if (form.costYuan && (!Number.isFinite(cost) || cost < 0)) {
      return wx.showToast({ icon: 'none', title: '参考成本填写不正确' });
    }

    const payload = {
      name: form.name.trim(),
      spec: form.spec.trim() || undefined,
      category: form.category || undefined,
      unit: form.unit.trim(),
      defaultCostCents: form.costYuan ? Math.round(cost * 100) : undefined,
      photoUrls: form.photoUrls || [],
      aliases: form.aliases
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      params: form.params.trim() || undefined,
      enabled: form.enabled,
    };

    this.setData({ saving: true });
    try {
      if (form.id) {
        await inventory.updateMaterial(form.id, payload);
        wx.showToast({ title: '已保存' });
      } else {
        await inventory.createMaterial(payload);
        wx.showToast({ title: '材料已新增' });
      }
      this.setData({ editorOpen: false });
      this.syncSheetTabBar();
      await this.load();
    } catch (e: any) {
      // 服务端的真实原因要露出来（「已被单据引用不可改名」这类），别笼统一句「保存失败」
      wx.showToast({ icon: 'none', title: e?.message || '保存失败', duration: 3000 });
    } finally {
      this.setData({ saving: false });
    }
  },
});
