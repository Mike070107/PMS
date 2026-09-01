import { inventory, upload } from '@pms/api-client';
import {
  MATERIAL_CATEGORIES,
  MATERIAL_UNITS,
  type MaterialView,
  type StockView,
  type WarehouseLocationView,
  type WarehouseView,
} from '@pms/shared-types';
import { getSession, type StaffSession } from '../../utils/session';

/**
 * 新增材料 → 当场入库。
 *
 * 为什么不是「先建 SKU，再去别处入库」：
 * 1. 不先查就填，填到最后才被「已存在同名同型号」挡回来，前面输的全白输 ——
 *    所以第一步是**搜**，搜到就直接用，搜不到才建。
 * 2. 只建档不入库，得到的是一条零库存 SKU：库存页默认「仅显示有货」，它当场就
 *    从列表里消失，人会以为没建上、回头再建一次（2026-09-01 就是这么撞上
 *    「提示已存在 WJ-0010，可我翻到 WJ-0009 就没了」的）。
 *    所以建完直接进入库那一步，填数量/单价/来源/库位，落一张入库单。
 *
 * 三个模式共用一个页面（search → create → inbound），不拆页是因为
 * 「找不到 → 新建 → 接着填数量」是一口气的事，跳来跳去会丢上下文。
 */

/** 一条 SKU 最多几张实物照片，和后端 MATERIAL_PHOTO_LIMIT 是一套账 */
const PHOTO_LIMIT = 4;

interface SkuRow {
  materialId: number;
  title: string;
  code: string;
  unit: string;
  category: string;
  photoUrl: string;
  photoUrls: string[];
  defaultCostCents: number;
  /** 在当前选中仓的存量，搜索结果里直接写出来，省得选完才发现仓里还有一堆 */
  qtyText: string;
}

const num = (value: string | number) => Number(value ?? 0);

/** 老数据只有单图字段，新数据有数组；取用一律走这里 */
function photoList(item: { photoUrl?: string | null; photoUrls?: string[] | null }): string[] {
  const list = (item.photoUrls || []).filter(Boolean) as string[];
  if (list.length) return list;
  return item.photoUrl ? [item.photoUrl] : [];
}

/**
 * 默认入库到哪个仓：本人角色范围对应的管理处那个仓。
 * 判据和库存页 defaultWarehouseIndex 一致（列表已由服务端按范围排好，
 * 第一个挂了管理处的就是自己的仓）；对不上就落到第一个仓，入库必须有个具体的仓。
 */
function defaultWarehouseIndex(session: StaffSession, warehouses: WarehouseView[]): number {
  if (!warehouses.length) return -1;
  const access = session.me?.access;
  if (access && !access.scopeAll) {
    const index = warehouses.findIndex((w) => w.enabled && !!w.officeId);
    if (index >= 0) return index;
  }
  return 0;
}

Page({
  data: {
    loading: true,
    canEdit: false,
    roleHint: '',
    /** search = 找有没有现成的；create = 建一条新的；inbound = 填入库信息 */
    mode: 'search' as 'search' | 'create' | 'inbound',

    keyword: '',
    results: [] as SkuRow[],
    /** 搜索词非空但一条都没匹配上 —— 这时才提示「新建」，否则一进来就在劝人新建 */
    searched: false,

    selected: null as SkuRow | null,
    /** 这条 SKU 是本次刚建的：入库那一步要多给一个「只建档，暂不入库」的出口 */
    justCreated: false,

    // ---- 新建 SKU ----
    createForm: {
      name: '',
      spec: '',
      category: '',
      unit: '个',
      costYuan: '',
      aliases: '',
      params: '',
      photoUrls: [] as string[],
    },
    units: MATERIAL_UNITS,
    categories: MATERIAL_CATEGORIES,
    unitIndex: Math.max(0, MATERIAL_UNITS.indexOf('个')),
    categoryIndex: -1,
    createErrors: { name: '', category: '' },

    // ---- 入库 ----
    warehouses: [] as WarehouseView[],
    warehouseNames: [] as string[],
    warehouseIndex: -1,
    noWarehouseHint: '',
    locations: [] as WarehouseLocationView[],
    /** 第 0 项固定是「不指定库位」，其余错一位对应 locations */
    locationNames: ['不指定库位'] as string[],
    locationIndex: 0,
    inboundForm: {
      qty: '',
      priceYuan: '',
      sourceText: '',
      photoUrls: [] as string[],
    },
    inboundErrors: { qty: '', priceYuan: '', sourceText: '' },
    amountText: '',

    uploading: false,
    saving: false,
  },

  /** 全量 SKU 和库存放实例上，搜索在本地做，边打字边请求既慢又费流量 */
  materials: [] as MaterialView[],
  stocks: [] as StockView[],

  onLoad() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const session = await getSession(this);
      if (!session.canEditMaterials) {
        this.setData({
          canEdit: false,
          roleHint:
            '你的账号只能查看材料，不能新增或入库。请管理员在管理后台「业务角色」页，把你的角色在员工端小程序那张表里「材料与库存」这一行的「改材料信息」勾上。',
        });
        return;
      }
      const [materials, warehouses, stocks] = await Promise.all([
        inventory.listMaterials(),
        // 只拿本人范围能入的仓：自己管理处的排最前
        inventory.listWarehouses({ scope: 'mine' }),
        inventory.listStocks(),
      ]);
      this.materials = materials;
      this.stocks = stocks;
      const enabled = warehouses.filter((item) => item.enabled);
      const warehouseIndex = defaultWarehouseIndex(session, enabled);
      this.setData(
        {
          canEdit: true,
          warehouses: enabled,
          warehouseNames: enabled.map((item) => item.name),
          warehouseIndex,
          noWarehouseHint: enabled.length
            ? ''
            : '你所属的管理处还没有仓库，入库没有去处。请办公室在管理后台「库存与采购 → 基础资料 → 仓库档案」里给管理处建仓（新建管理处会自动带一个同名仓）。',
        },
        () => this.loadLocations(),
      );
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 库位跟着仓走：换了仓还留着上一个仓的库位，入库就落到别人家货架上了 */
  async loadLocations() {
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    if (!warehouse) {
      this.setData({ locations: [], locationNames: ['不指定库位'], locationIndex: 0 });
      return;
    }
    try {
      const list = (await inventory.listWarehouseLocations({ warehouseId: warehouse.id })).filter(
        (item) => item.enabled,
      );
      // 仓库配了默认库位就替他选上，省得每次入库都从头挑
      const defaultIndex = warehouse.defaultLocationId
        ? list.findIndex((item) => item.id === warehouse.defaultLocationId)
        : -1;
      this.setData({
        locations: list,
        locationNames: ['不指定库位', ...list.map((item) => item.label)],
        locationIndex: defaultIndex >= 0 ? defaultIndex + 1 : 0,
      });
    } catch {
      // 没配库位不影响入库，静默退回「不指定库位」，别弹一个红条吓人
      this.setData({ locations: [], locationNames: ['不指定库位'], locationIndex: 0 });
    }
  },

  /** 某条 SKU 在当前选中仓的存量 */
  stockOf(materialId: number): number {
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    if (!warehouse) return 0;
    return (this.stocks as StockView[])
      .filter((item) => item.materialId === materialId && item.warehouseId === warehouse.id)
      .reduce((sum, item) => sum + num(item.qty), 0);
  },

  toRow(material: MaterialView): SkuRow {
    const qty = this.stockOf(material.id);
    const photos = photoList(material);
    return {
      materialId: material.id,
      title: material.spec ? `${material.name} · ${material.spec}` : material.name,
      code: material.code,
      unit: material.unit,
      category: (material.category || '').trim() || '未分类',
      photoUrl: photos[0] || '',
      photoUrls: photos,
      defaultCostCents: material.defaultCostCents || 0,
      qtyText: qty > 0 ? `本仓 ${qty}${material.unit}` : '本仓无货',
    };
  },

  // ---------------- 第一步：先搜有没有现成的 ----------------

  onKeyword(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value;
    this.setData({ keyword }, () => this.applySearch());
  },

  applySearch() {
    const kw = this.data.keyword.trim().toLowerCase();
    if (!kw) {
      this.setData({ results: [], searched: false });
      return;
    }
    // 停用的也要搜出来：它就是「已存在同名同型号」拦人的那一条，藏起来只会让人再建一遍
    const matched = (this.materials as MaterialView[])
      .filter((material) =>
        [material.name, material.spec, material.code, material.category, ...(material.aliases || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 50)
      .map((material) => this.toRow(material));
    this.setData({ results: matched, searched: true });
  },

  onPickExisting(e: WechatMiniprogram.BaseEvent) {
    const row = this.data.results[Number(e.currentTarget.dataset.index)];
    if (row) this.selectSku(row, false);
  },

  /** 选定一条 SKU，进入入库那一步；单价先用它的参考成本垫上，改不改随人 */
  selectSku(row: SkuRow, justCreated: boolean) {
    this.setData(
      {
        selected: row,
        justCreated,
        mode: 'inbound',
        'inboundForm.priceYuan': row.defaultCostCents ? String(row.defaultCostCents / 100) : '',
        inboundErrors: { qty: '', priceYuan: '', sourceText: '' },
      },
      () => this.refreshAmount(),
    );
  },

  onBackToSearch() {
    this.setData({ mode: 'search', selected: null, justCreated: false });
  },

  // ---------------- 第二步之一：搜不到，新建一条 ----------------

  onStartCreate() {
    // 搜索词多半就是材料名，直接带过去，别让人再打一遍
    this.setData({
      mode: 'create',
      'createForm.name': this.data.keyword.trim(),
      createErrors: { name: '', category: '' },
    });
  },

  onCreateInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    this.setData({ [`createForm.${field}`]: e.detail.value, [`createErrors.${field}`]: '' });
  },

  onCreateUnit(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ unitIndex: index, 'createForm.unit': MATERIAL_UNITS[index] });
  },

  onCreateCategory(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({
      categoryIndex: index,
      'createForm.category': MATERIAL_CATEGORIES[index],
      'createErrors.category': '',
    });
  },

  async onSaveCreate() {
    const form = this.data.createForm;
    const name = form.name.trim();
    const spec = form.spec.trim();
    const errors = {
      name: name ? '' : '请填写材料名称',
      category: form.category ? '' : '请选择类别（决定材料编码前缀）',
    };
    this.setData({ createErrors: errors });
    if (errors.name || errors.category) return;

    const cost = Number(form.costYuan);
    if (form.costYuan && (!Number.isFinite(cost) || cost < 0)) {
      return wx.showToast({ icon: 'none', title: '参考成本填写不正确' });
    }

    // 服务端也会判重，这里先本地拦一道：拦下来能**直接把那条选中**接着入库，
    // 而不是甩一句「已存在 WJ-0010」让人自己去列表里翻（还翻不到 —— 它无货）
    const dup = (this.materials as MaterialView[]).find(
      (item) => item.name.trim() === name && (item.spec || '').trim() === spec,
    );
    if (dup) {
      wx.showToast({ icon: 'none', title: `已有「${dup.code}」，已为你选中`, duration: 2500 });
      this.selectSku(this.toRow(dup), false);
      return;
    }

    this.setData({ saving: true });
    try {
      const created = await inventory.createMaterial({
        name,
        spec: spec || undefined,
        category: form.category,
        unit: form.unit.trim() || '个',
        defaultCostCents: form.costYuan ? Math.round(cost * 100) : undefined,
        photoUrls: form.photoUrls,
        aliases: form.aliases
          .split(/[、,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        params: form.params.trim() || undefined,
      });
      this.materials = [...this.materials, created];
      wx.showToast({ title: `已建档 ${created.code}` });
      this.selectSku(this.toRow(created), true);
    } catch (e: any) {
      // 服务端的真实原因要露出来（判重提示里写着那条 SKU 的编码和状态）
      wx.showToast({ icon: 'none', title: e?.message || '保存失败', duration: 4000 });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------------- 第三步：填入库 ----------------

  onPickWarehouse(e: WechatMiniprogram.BaseEvent) {
    this.setData({ warehouseIndex: Number(e.currentTarget.dataset.index) }, () => {
      this.loadLocations();
      // 换仓之后「本仓存量」这句就变了，重算一遍
      const selected = this.data.selected;
      if (selected) {
        const material = (this.materials as MaterialView[]).find(
          (item) => item.id === selected.materialId,
        );
        if (material) this.setData({ selected: this.toRow(material) });
      }
    });
  },

  onPickLocation(e: WechatMiniprogram.PickerChange) {
    this.setData({ locationIndex: Number(e.detail.value) });
  },

  onInboundInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    this.setData({ [`inboundForm.${field}`]: e.detail.value, [`inboundErrors.${field}`]: '' }, () =>
      this.refreshAmount(),
    );
  },

  /** 数量 × 单价当场算出来给他看：一位数点错，这里立刻看得出来 */
  refreshAmount() {
    const qty = Number(this.data.inboundForm.qty);
    const price = Number(this.data.inboundForm.priceYuan);
    const ok = Number.isFinite(qty) && qty > 0 && Number.isFinite(price) && price >= 0;
    this.setData({ amountText: ok ? `合计 ¥${(qty * price).toFixed(2)}` : '' });
  },

  // ---------------- 照片：建档和入库两处共用 ----------------

  async onChoosePhoto(e: WechatMiniprogram.BaseEvent) {
    if (this.data.uploading) return;
    const target = (e.currentTarget.dataset.target as 'createForm' | 'inboundForm') || 'createForm';
    const current = (this.data[target].photoUrls || []) as string[];
    const room = PHOTO_LIMIT - current.length;
    if (room <= 0) {
      return wx.showToast({ icon: 'none', title: `最多 ${PHOTO_LIMIT} 张照片` });
    }
    const res = await wx
      .chooseMedia({ count: room, mediaType: ['image'], sourceType: ['camera', 'album'] })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setData({
        [`${target}.photoUrls`]: [...current, ...uploaded.map((item) => item.publicUrl)].slice(
          0,
          PHOTO_LIMIT,
        ),
      });
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const target = (e.currentTarget.dataset.target as 'createForm' | 'inboundForm') || 'createForm';
    const index = Number(e.currentTarget.dataset.index);
    const next = ((this.data[target].photoUrls || []) as string[]).filter((_, i) => i !== index);
    this.setData({ [`${target}.photoUrls`]: next });
  },

  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    const list = urls.length ? urls : url ? [url] : [];
    if (!list.length) return;
    wx.previewImage({ current: url || list[0], urls: list });
  },

  // ---------------- 提交 ----------------

  async onSubmitInbound() {
    const selected = this.data.selected;
    const warehouse = this.data.warehouses[this.data.warehouseIndex];
    if (!selected) return;
    if (!warehouse) {
      return wx.showToast({ icon: 'none', title: '请先选择入库仓库', duration: 3000 });
    }
    const qty = Number(this.data.inboundForm.qty);
    const price = Number(this.data.inboundForm.priceYuan);
    const sourceText = this.data.inboundForm.sourceText.trim();
    const errors = {
      qty: Number.isFinite(qty) && qty > 0 ? '' : '请填写入库数量',
      priceYuan: Number.isFinite(price) && price >= 0 ? '' : '请填写入库单价',
      sourceText: sourceText ? '' : '请填写入库来源（如：XX 五金店零星采买）',
    };
    this.setData({ inboundErrors: errors });
    if (errors.qty || errors.priceYuan || errors.sourceText) return;

    const location = this.data.locationIndex > 0 ? this.data.locations[this.data.locationIndex - 1] : null;
    this.setData({ saving: true });
    try {
      const receipt = await inventory.createGeneralReceipt({
        warehouseId: warehouse.id,
        sourceText,
        items: [
          {
            materialId: selected.materialId,
            qty,
            unitCostCents: Math.round(price * 100),
            // 实物照片选填，事后能在材料档案里补
            photoUrls: this.data.inboundForm.photoUrls,
            locationId: location?.id,
          },
        ],
      });
      wx.showModal({
        title: '入库完成',
        content:
          `入库单 ${receipt.receiptNo}\n${selected.title} ${qty}${selected.unit} 已入「${warehouse.name}」` +
          (location ? `（${location.label}）` : ''),
        showCancel: false,
        confirmText: '知道了',
        success: () => wx.navigateBack(),
      });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '入库失败', duration: 4000 });
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 刚建完档但这会儿还不入库（货还没到）：留着 SKU 直接走人 */
  onSkipInbound() {
    wx.showModal({
      title: '暂不入库？',
      content: '材料已经建好档，但库存是 0，在库存页默认的「仅显示有货」下看不到它。货到了回来这里搜名字入库即可。',
      confirmText: '就这样',
      cancelText: '继续入库',
      success: (res) => {
        if (res.confirm) wx.navigateBack();
      },
    });
  },
});
