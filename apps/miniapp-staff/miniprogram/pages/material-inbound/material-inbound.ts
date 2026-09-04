import { inventory, materialAi, upload } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
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

/**
 * 语音走微信官方「同声传译」插件（**只支持普通话**，没有上海话等方言）。
 * 插件没装时 speechManager 一直是 null，「按住说话」整个按钮不显示，打字照常可用。
 */
let speechManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  speechManager = requirePlugin('WechatSI').getRecordRecognitionManager();
} catch {
  speechManager = null;
}
let hold: HoldToTalk | null = null;

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
    /** 类别档案由服务端给（后台「基础资料 → 材料类别」可增删改），不用写死的常量 */
    categories: [] as string[],
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
    },
    inboundErrors: { qty: '', priceYuan: '', sourceText: '' },
    amountText: '',

    uploading: false,
    saving: false,

    // ---- 语音填表 ----
    /** 同声传译插件在不在。不在就整个隐藏「按住说话」，打字照常可用 */
    hasSpeech: false,
    recording: false,
    /** 识别中的实时文字，让人知道在听 */
    partial: '',
    /** 正在让模型整理 */
    aiBusy: false,
    /** 「听到：…」「已填：名称、型号」「类别没听准，请自己选」——一律说人话，别只转圈 */
    aiHint: '',
  },

  /** 全量 SKU 和库存放实例上，搜索在本地做，边打字边请求既慢又费流量 */
  materials: [] as MaterialView[],
  stocks: [] as StockView[],
  /** 第一步说话时顺带听到的数量/单价，选中 SKU 进第三步时补上 */
  pendingInbound: null as { qty: number | null; priceYuan: number | null } | null,

  onLoad() {
    this.bindSpeech();
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
      const [materials, warehouses, stocks, categories] = await Promise.all([
        inventory.listMaterials(),
        // 只拿本人范围能入的仓：自己管理处的排最前
        inventory.listWarehouses({ scope: 'mine' }),
        inventory.listStocks(),
        // 停用的类别不让选：新建时选不到，老材料照常显示
        inventory.listMaterialCategories().catch(() => []),
      ]);
      this.materials = materials;
      this.stocks = stocks;
      const enabled = warehouses.filter((item) => item.enabled);
      const warehouseIndex = defaultWarehouseIndex(session, enabled);
      this.setData(
        {
          canEdit: true,
          categories: categories.filter((item) => item.enabled).map((item) => item.label),
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
      () => {
        this.refreshAmount();
        // 第一步说话时顺带听到的数量/单价，到这一步补上（只补空着的）
        this.applyPendingInbound();
      },
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
      'createForm.category': this.data.categories[index],
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

  // ---------------- 语音填表：说一句，AI 只负责填，每一步都由人确认 ----------------

  /**
   * 三步都能说：
   * - 找材料：说「找个门禁按键」→ 抽出关键词填进搜索框并搜；顺带说了数量单价就先存着，
   *   进到第三步自动带上，不用再说一遍。
   * - 建档：说一段描述 → 名称/型号/单位/别名/详细参数/类别 一次填好。
   * - 入库：说「20 个，一个 3 块 5」→ 填数量和单价。
   *
   * **AI 只填表**：不建档、不入库、不动库存，每一步都要人核对后自己点按钮。
   * 识别文本也一定落在可编辑的输入框里，听错了当场能改（见全局约定：语音结果必须可编辑）。
   */
  bindSpeech() {
    if (!speechManager) return;
    this.setData({ hasSpeech: true });
    hold = createHoldToTalk(speechManager);
    speechManager.onStart = () => {
      this.setData({ recording: true, partial: '' });
      hold?.started();
    };
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ partial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      hold?.ended();
      const text = (res.result || this.data.partial || '').trim();
      this.setData({ recording: false, partial: '' });
      if (!text) {
        this.setData({ aiHint: '没听清，再按住说一次' });
        return;
      }
      void this.applySpeechText(text);
    };
    speechManager.onError = (err: { retcode?: number; msg?: string }) => {
      hold?.ended();
      this.setData({ recording: false, partial: '' });
      // speechErrorTip 会先查网络再给话术（没网就直说没网），是异步的
      void speechErrorTip(err).then((tip) => this.setData({ aiHint: tip }));
    };
  },

  onStartRecord() {
    this.setData({ aiHint: '' });
    hold?.press();
  },

  /** touchend 和 touchcancel 都指到这里：手指滑出按钮、被来电打断也要收尾 */
  onStopRecord() {
    hold?.release();
  },

  async applySpeechText(spoken: string) {
    this.setData({ aiBusy: true, aiHint: `听到：${spoken}` });
    try {
      if (this.data.mode === 'create') await this.fillCreateFromSpeech(spoken);
      else if (this.data.mode === 'inbound') await this.fillInboundFromSpeech(spoken);
      else await this.fillSearchFromSpeech(spoken);
    } catch (e: any) {
      this.setData({ aiHint: e?.message || '识别服务暂时不可用，按原样手工填即可' });
    } finally {
      this.setData({ aiBusy: false });
    }
  },

  /** 第一步：抽出材料关键词去搜；顺带听到的数量/单价存起来给第三步 */
  async fillSearchFromSpeech(spoken: string) {
    const resp = await materialAi.parseReceipt({ text: spoken });
    if (!resp.ok || !resp.items.length) {
      // 识别不出材料名就把原话填进搜索框，总比清空强 —— 人可以自己删两个字接着搜
      this.setData({ keyword: spoken, aiHint: '没听出材料名，已把原话填进搜索框，可以自己改' });
      this.applySearch();
      return;
    }
    const first = resp.items[0];
    const keyword = [first.spokenName, first.spokenSpec].filter(Boolean).join(' ').trim();
    // 数量和单价先存着：选中/建档之后进第三步自动填上，不用再说一遍
    this.pendingInbound = {
      qty: first.qty,
      priceYuan: first.unitPriceCents == null ? null : first.unitPriceCents / 100,
    };
    const extra = [
      first.qty ? `数量 ${first.qty}` : '',
      first.unitPriceCents == null ? '' : `单价 ¥${(first.unitPriceCents / 100).toFixed(2)}`,
    ].filter(Boolean).join('、');
    this.setData({
      keyword,
      aiHint: `按「${keyword}」搜索${extra ? `；${extra}已记下，入库那一步自动填上` : ''}`,
    });
    this.applySearch();
  },

  /** 第二步：一段描述 → 档案草稿。类别只会落在本公司已有的类别上 */
  async fillCreateFromSpeech(spoken: string) {
    const resp = await materialAi.parseProfile({ text: spoken });
    if (!resp.ok || !resp.draft) {
      this.setData({
        aiHint: resp.reason === 'ai_unavailable'
          ? '还没配 AI 服务（后台「系统设置 → AI 辅助」），请手工填'
          : '这次没识别出来，请手工填',
      });
      return;
    }
    const draft = resp.draft;
    const patch: Record<string, unknown> = {};
    if (draft.name) patch['createForm.name'] = draft.name;
    if (draft.spec) patch['createForm.spec'] = draft.spec;
    if (draft.params) patch['createForm.params'] = draft.params;
    if (draft.aliases.length) patch['createForm.aliases'] = draft.aliases.join('、');
    const unitIndex = draft.unit ? MATERIAL_UNITS.indexOf(draft.unit) : -1;
    if (unitIndex >= 0) {
      patch.unitIndex = unitIndex;
      patch['createForm.unit'] = MATERIAL_UNITS[unitIndex];
    }
    const categoryIndex = draft.category ? this.data.categories.indexOf(draft.category) : -1;
    if (categoryIndex >= 0) {
      patch.categoryIndex = categoryIndex;
      patch['createForm.category'] = this.data.categories[categoryIndex];
      patch['createErrors.category'] = '';
    }
    if (draft.name) patch['createErrors.name'] = '';
    const filled = [
      draft.name && '名称', draft.spec && '型号', unitIndex >= 0 && '单位',
      categoryIndex >= 0 && '类别', draft.aliases.length && '别名', draft.params && '详细参数',
    ].filter(Boolean).join('、');
    this.setData({
      ...patch,
      aiHint: filled
        // 类别没填上要说清为什么，别让人对着空下拉猜
        ? `已填：${filled}。${categoryIndex >= 0 ? '' : '类别没听准，请自己选一个（它决定材料编码前缀）。'}核对无误再点建档`
        : '这次没识别出可填的内容，请手工填',
    });
  },

  /** 第三步：数量和单价 */
  async fillInboundFromSpeech(spoken: string) {
    const resp = await materialAi.parseReceipt({ text: spoken });
    const first = resp.ok ? resp.items[0] : null;
    if (!first || (first.qty == null && first.unitPriceCents == null)) {
      this.setData({ aiHint: '没听出数量或单价，说法可以是「20 个，一个 3 块 5」' });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (first.qty != null) { patch['inboundForm.qty'] = String(first.qty); patch['inboundErrors.qty'] = ''; }
    if (first.unitPriceCents != null) {
      patch['inboundForm.priceYuan'] = (first.unitPriceCents / 100).toFixed(2);
      patch['inboundErrors.priceYuan'] = '';
    }
    this.setData({
      ...patch,
      aiHint: `已填：${[first.qty != null && '数量', first.unitPriceCents != null && '单价'].filter(Boolean).join('、')}。核对无误再提交`,
    });
    this.refreshAmount();
  },

  /** 第一步顺带听到的数量/单价，进到入库那一步补上（只补空着的，不覆盖人已经改过的） */
  applyPendingInbound() {
    const pending = this.pendingInbound;
    if (!pending) return;
    const patch: Record<string, unknown> = {};
    if (pending.qty != null && !this.data.inboundForm.qty) patch['inboundForm.qty'] = String(pending.qty);
    if (pending.priceYuan != null && !this.data.inboundForm.priceYuan) {
      patch['inboundForm.priceYuan'] = pending.priceYuan.toFixed(2);
    }
    this.pendingInbound = null;
    if (!Object.keys(patch).length) return;
    this.setData({ ...patch, aiHint: '数量/单价按你刚才说的先填上了，核对无误再提交' });
    this.refreshAmount();
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

  // ---------------- 照片：只有「新建 SKU」那一步有 ----------------
  //
  // 入库那一步不放照片：它只会写进入库单，替代不了材料档案的照片，端上也翻不出来看。
  // 保留 data-target 参数是为了以后真有第二处要传图时不用再改一遍签名。

  async onChoosePhoto(e: WechatMiniprogram.BaseEvent) {
    if (this.data.uploading) return;
    const target = (e.currentTarget.dataset.target as 'createForm') || 'createForm';
    const current = (this.data[target].photoUrls || []) as string[];
    const room = PHOTO_LIMIT - current.length;
    if (room <= 0) {
      return wx.showToast({ icon: 'none', title: `最多 ${PHOTO_LIMIT} 张照片` });
    }
    const res = await wx
      // 显式要压缩图，别靠微信默认值（理由同库存页）
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
    const target = (e.currentTarget.dataset.target as 'createForm') || 'createForm';
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
