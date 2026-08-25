import { repairs, upload } from '@pms/api-client';
import {
  buildTimeline,
  missingMaterialsText,
  statusLabel,
  type TimelineRow,
} from '@pms/miniapp-ui';
import {
  formatDateTimeCn,
  REPAIR_TYPE_LABELS,
  stayDaysText,
  stayTone,
  stayDays,
  WorkOrderStatus,
  type WorkOrderStockOption,
  type WorkOrderStockWarehouse,
  type WorkOrderDetail,
} from '@pms/shared-types';

/**
 * 「添加用料」的一行。
 *
 * materialId 有值 = 从某个仓的库存里选的（warehouseId 记着是哪个），完工时按它扣库存、记出库流水；
 * 只有 name = 现场手填（仓里根本没有这东西），这种只能走缺料登记让办公室去采购。
 * stockQty 是选中那一刻的可用量，用来判断「够不够」——不够的行也允许留着，
 * 提交时会被拦下并提示改走缺料登记。
 */
interface MaterialRow {
  materialId: number | null;
  name: string;
  qty: string;
  unit: string;
  photoUrl: string;
  code: string;
  /** 选中那一刻所在仓的可用量；手填的行为 -1（= 仓里没有这个 SKU） */
  stockQty: number;
  /** 从哪个仓领的（完工时按它扣库存）。手填的行为 null。
      必须一行一个：选料途中切过仓库，整单共用一个 warehouseId 就会扣错仓。 */
  warehouseId: number | null;
  /** 下面两个由 setMaterialRows 算好 —— wxml 里调不了函数 */
  hintText: string;
  hintShort: boolean;
}

/**
 * 每个状态下「接下来该做什么」，直接写在详情页最上面。
 * 之前一屏并排四个同样大小的按钮（联系业主/接单/提报缺料/提交完工），
 * 维修工第一反应是「我现在该按哪个」—— 状态机自己知道答案，就别让人猜。
 */
const NEXT_STEP: Record<string, string> = {
  [WorkOrderStatus.CREATED]: '还没人接，点下面「接单」就归你',
  [WorkOrderStatus.DISPATCHED]: '已派给你，点下面「接单」开始处理',
  [WorkOrderStatus.IN_PROGRESS]: '先「添加用料」记下领了什么，修完点「完工提交」',
  [WorkOrderStatus.WAITING_MATERIAL]: '等采购到货；到货后接回这单继续修',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '已提交，等待业主验收（超时后系统自动完成）',
  [WorkOrderStatus.COMPLETED]: '这单已结束',
  [WorkOrderStatus.CANCELLED]: '这单已撤销',
};

/** 数量默认 1：缺料十有八九就是缺一个，让人少点一下 */
const DEFAULT_QTY = '1';
const MAX_QTY = 999;

const emptyMaterialRow = (): MaterialRow => ({
  materialId: null,
  name: '',
  qty: DEFAULT_QTY,
  unit: '',
  photoUrl: '',
  code: '',
  stockQty: -1,
  warehouseId: null,
  hintText: '',
  hintShort: false,
});

/** 每行的库存提示：够 / 不够 / 仓里没有，直接写成一句话贴在行里 */
function decorateRow(row: MaterialRow): MaterialRow {
  const need = Number(row.qty) || 0;
  if (!row.materialId) {
    return row.name
      ? { ...row, hintText: '仓库里没有这项，提报缺料后由办公室采购', hintShort: true }
      : { ...row, hintText: '', hintShort: false };
  }
  if (row.stockQty <= 0) {
    return { ...row, hintText: '所选仓库无库存，需走缺料登记', hintShort: true };
  }
  if (need > row.stockQty) {
    return {
      ...row,
      hintText: `所选仓库只剩 ${row.stockQty}${row.unit}，不够，需走缺料登记`,
      hintShort: true,
    };
  }
  return { ...row, hintText: `所选仓库可用 ${row.stockQty}${row.unit}`, hintShort: false };
}

/** 表单行 → 提交用的数组（去空行、数量转数字） */
function collectRows(rows: MaterialRow[]) {
  return rows
    .map((row) => ({
      materialId: row.materialId ?? undefined,
      name: row.name.trim(),
      qty: Number(row.qty),
      unit: row.unit || undefined,
      stockQty: row.stockQty,
      warehouseId: row.warehouseId ?? undefined,
    }))
    .filter((row) => row.name);
}

interface PageData {
  id: string;
  detail: WorkOrderDetail | null;
  typeLabel: string;
  createdAtText: string;
  /** 从业主提交那刻算起的停留天数，工单池里最该被看见的信息 */
  stayText: string;
  stayTone: string;
  timeline: TimelineRow[];
  canAccept: boolean;
  canComplete: boolean;
  /** 缺料登记只在「维修中」开放：还没接单先接单，等待材料的单已经在池子里了 */
  canNeedMaterial: boolean;
  /** 已提报的缺料清单，等待材料时给接单的人看 */
  missingText: string;
  acceptText: string;
  /** 顶部「现在什么状态、接下来该做什么」 */
  statusText: string;
  nextStep: string;
  /** 底部弹出的表单：'' 关闭 / material 缺料登记 / complete 完工提交 */
  panel: string;
  /** 进度默认只露最新一条，点开看全部 */
  timelineOpen: boolean;
  contactPhone: string;
  resultAttachments: string[];
  actionNote: string;
  faultLocation: string;
  faultSymptom: string;
  /** 收费金额（元，字符串便于输入）；提交时换算成分 */
  feeYuan: string;
  uploading: boolean;
  busy: boolean;
  errorMsg: string;
  /** 添加用料 */
  materialRows: Array<MaterialRow & { hintText: string; hintShort: boolean }>;
  materialNote: string;
  materialError: string;
  /** 有一行库存不够或仓里没有 —— 面板底部要给「提报缺料」这条出路 */
  hasShortage: boolean;
  /** 库存选择器 */
  skuOpen: boolean;
  skuLoading: boolean;
  skuError: string;
  skuKeyword: string;
  skuList: WorkOrderStockOption[];
  skuTargetIndex: number;
  /** 类别筛选条：只列这个仓真有的类别，-1 = 全部 */
  skuCategories: string[];
  skuCategoryIndex: number;
  warehouseName: string;
  /** 面板标题：没仓时要写明「未配领料仓库」，不能还挂着一个仓名 */
  skuTitle: string;
  /** 当前在看的仓库；本单「小区 + 类型」没配、也没手动切时为 null */
  skuWarehouseId: number | null;
  /** 可手动切换的仓库，后台配好的那个排最前 */
  warehouses: WorkOrderStockWarehouse[];
  /** 没配仓库 / 当前仓空了的出路提示 */
  skuEmptyHint: string;
  /** 维修说明的常用话术（按本单报修类型给），点一下填进去 */
  phrases: Array<{ text: string; on: boolean }>;
}

Page<PageData, WechatMiniprogram.IAnyObject>({
  data: {
    id: '',
    detail: null,
    typeLabel: '',
    createdAtText: '',
    stayText: '',
    stayTone: 'normal',
    timeline: [],
    canAccept: false,
    canComplete: false,
    canNeedMaterial: false,
    missingText: '',
    acceptText: '接单',
    statusText: '',
    nextStep: '',
    panel: '',
    timelineOpen: false,
    contactPhone: '',
    resultAttachments: [],
    actionNote: '',
    faultLocation: '',
    faultSymptom: '',
    feeYuan: '',
    uploading: false,
    busy: false,
    errorMsg: '',
    materialRows: [],
    materialNote: '',
    materialError: '',
    hasShortage: false,
    skuOpen: false,
    skuLoading: false,
    skuError: '',
    skuKeyword: '',
    skuList: [],
    skuTargetIndex: 0,
    skuCategories: [],
    skuCategoryIndex: -1,
    warehouseName: '',
    skuTitle: '选择材料',
    skuWarehouseId: null,
    warehouses: [],
    skuEmptyHint: '',
    phrases: [],
  },

  /** 当前仓库的库存清单放实例上，筛选在本地做，翻来翻去不用每次都请求 */
  allSkus: [] as WorkOrderStockOption[],
  /** 当前在看的仓库 id：从这里选中的行会把它记进 row.warehouseId */
  warehouseId: null as number | null,

  onLoad(q: Record<string, string>) {
    this.setData({ id: q.id || '' });
    this.load();
  },

  async load() {
    if (!this.data.id) return;
    try {
      const detail = await repairs.detail(this.data.id);
      const status = detail.workOrder.status;
      // 缺料提报后工单会退回工单池（assigneeId 置空），所以「等待材料 + 没人认领」
      // 要给的是接单按钮而不是完工表单。存量数据里还有挂着人的等待材料单，那种仍按在手工单处理。
      const waitingInPool =
        status === WorkOrderStatus.WAITING_MATERIAL && !detail.workOrder.assigneeId;
      this.setData({
        detail,
        // 中文类型名以后端为准，租户自建的类型端上认不出（会显示成 menjing 这种编码）
        typeLabel:
          detail.request?.repairTypeLabel ||
          REPAIR_TYPE_LABELS[detail.request?.repairType || ''] ||
          detail.request?.repairType ||
          '其它',
        createdAtText: formatDateTimeCn(detail.workOrder.createdAt),
        stayText: stayDaysText(
          detail.workOrder.createdAt,
          detail.workOrder.completedAt ? new Date(detail.workOrder.completedAt) : new Date(),
        ),
        stayTone: stayTone(
          stayDays(
            detail.workOrder.createdAt,
            detail.workOrder.completedAt ? new Date(detail.workOrder.completedAt) : new Date(),
          ),
        ),
        timeline: buildTimeline(detail.logs, statusLabel, { finished: [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED].indexOf(status) >= 0 }),
        canAccept:
          status === WorkOrderStatus.CREATED ||
          status === WorkOrderStatus.DISPATCHED ||
          waitingInPool,
        canComplete:
          status === WorkOrderStatus.IN_PROGRESS ||
          (status === WorkOrderStatus.WAITING_MATERIAL && !waitingInPool),
        canNeedMaterial: status === WorkOrderStatus.IN_PROGRESS,
        missingText: missingMaterialsText(detail.workOrder.missingMaterials),
        acceptText: waitingInPool ? '材料到了，接回' : '接单',
        statusText: statusLabel[status] || status,
        nextStep: NEXT_STEP[status] || '',
        contactPhone: detail.request?.contactPhone || '',
        // 故障位置/现象从报修信息带出来：业主已经说过一遍了，别让维修工再打一遍。
        // 带出来的只是初值，可以改、也可以清空 —— 现场看到的往往和业主说的不一样。
        faultLocation:
          this.data.faultLocation ||
          detail.workOrder.faultLocation ||
          detail.request?.addressText ||
          '',
        faultSymptom:
          this.data.faultSymptom ||
          detail.workOrder.faultSymptom ||
          detail.request?.content ||
          '',
        feeYuan:
          this.data.feeYuan || (detail.workOrder.feeCents ? String(detail.workOrder.feeCents / 100) : ''),
      });
      if (this.data.canComplete) this.loadPhrases(detail.request?.repairType || '');
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  /** 常用话术拿不到不影响完工，静默失败即可，别弹一个红条吓人 */
  async loadPhrases(repairType: string) {
    try {
      const data = await repairs.actionSuggestions();
      // 这个类型还没积累出话术时用通用的兜底，别给一片空白
      const byType = data.byType?.[repairType] || [];
      const list = byType.length ? byType : data.general || [];
      this.setData({
        phrases: list.slice(0, 12).map((item) => ({
          text: item.text,
          on: this.data.actionNote.indexOf(item.text) >= 0,
        })),
      });
    } catch {
      this.setData({ phrases: [] });
    }
  },

  async onAccept() {
    this.setData({ busy: true, errorMsg: '' });
    try {
      await repairs.accept(this.data.id);
      wx.showToast({ title: '已接单' });
      this.load();
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '接单失败' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onCall() {
    const phone = this.data.contactPhone;
    if (!phone) {
      return wx.showToast({ icon: 'none', title: '该报修没有留联系电话' });
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  onPreviewRequestImage(e: WechatMiniprogram.BaseEvent) {
    const urls = this.data.detail?.request?.attachments || [];
    if (!urls.length) return;
    wx.previewImage({ current: e.currentTarget.dataset.url, urls });
  },

  async onChooseMedia() {
    if (this.data.uploading) return;
    const res = await wx
      .chooseMedia({ count: 6, mediaType: ['image'], sourceType: ['camera', 'album'] })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;

    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setData({
        resultAttachments: [
          ...this.data.resultAttachments,
          ...uploaded.map((item) => item.publicUrl),
        ],
        errorMsg: '',
      });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemoveMedia(e: WechatMiniprogram.BaseEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const next = this.data.resultAttachments.slice();
    next.splice(idx, 1);
    this.setData({ resultAttachments: next });
  },

  onNote(e: WechatMiniprogram.Input) {
    this.setData({ actionNote: e.detail.value, errorMsg: '' }, () => this.syncPhraseState());
  },

  /**
   * 点话术：没填过就追加到维修说明末尾，已填过就撤掉这一句。
   * 追加而不是覆盖 —— 一次维修常常是「更换阀芯」＋「重新缠生料带止漏」两件事，
   * 点完还能自己接着补细节，文本框始终可编辑。
   */
  onTapPhrase(e: WechatMiniprogram.BaseEvent) {
    const text = String(e.currentTarget.dataset.text || '');
    if (!text) return;
    const note = this.data.actionNote;
    let next: string;
    if (note.indexOf(text) >= 0) {
      next = note
        .split(/[，,；;]/)
        .map((part) => part.trim())
        .filter((part) => part && part !== text)
        .join('，');
    } else {
      next = note.trim() ? `${note.trim().replace(/[，,；;]+$/, '')}，${text}` : text;
    }
    this.setData({ actionNote: next, errorMsg: '' }, () => this.syncPhraseState());
  },

  syncPhraseState() {
    const note = this.data.actionNote;
    this.setData({
      phrases: this.data.phrases.map((item) => ({ ...item, on: note.indexOf(item.text) >= 0 })),
    });
  },

  onFaultInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as 'faultLocation' | 'faultSymptom';
    this.setData({ [field]: e.detail.value });
  },

  // ---------------- 底部弹出面板 ----------------

  /**
   * 缺料登记和完工提交都做成底部面板，而不是直接铺在详情页里。
   * 铺在页面里的后果是：一进详情就看见两张表单、一堆输入框，
   * 主线（这单现在该干嘛）被淹掉。现在页面只讲「是什么、到哪一步」，
   * 要动手时才从底部拉出对应的表单。
   */
  onOpenPanel(e: WechatMiniprogram.BaseEvent) {
    const panel = String(e.currentTarget.dataset.panel || '');
    this.setData({ panel, materialError: '', errorMsg: '' });
  },

  onClosePanel() {
    this.setData({ panel: '' });
  },

  /** 面板内容区滚动时不要把底下的页面也带着滚 */
  noop() {},

  onToggleTimeline() {
    this.setData({ timelineOpen: !this.data.timelineOpen });
  },

  /**
   * 用料行统一走这里写回：顺手算好每行的库存提示和「有没有缺料」，
   * wxml 里调不了函数，这些都得先算成字段。
   */
  setMaterialRows(rows: MaterialRow[]) {
    const decorated = rows.map(decorateRow);
    this.setData({
      materialRows: decorated,
      hasShortage: decorated.some((row) => !!row.name && row.hintShort),
      materialError: '',
    });
  },

  onMaterialInput(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field as 'name' | 'qty';
    const rows = this.data.materialRows.slice();
    rows[index] = { ...rows[index], [field]: e.detail.value };
    // 名称一旦被手改，就不再是库存里那一项了：关联 id 必须跟着摘掉，
    // 否则完工时按 id 扣的是另一样东西，而办公室看到的名字还是维修工写的这个。
    if (field === 'name') {
      rows[index].materialId = null;
      rows[index].unit = '';
      rows[index].photoUrl = '';
      rows[index].code = '';
      rows[index].stockQty = -1;
    }
    this.setMaterialRows(rows);
  },

  /**
   * 数量步进 ±1。现场戴着手套调数字，弹数字键盘再点一下比按一下加号麻烦得多；
   * 输入框仍然可以直接改（要 20 个就别按 19 次）。
   */
  onStepQty(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const step = Number(e.currentTarget.dataset.step);
    const rows = this.data.materialRows.slice();
    const current = Number(rows[index]?.qty);
    const base = Number.isFinite(current) && current > 0 ? current : 1;
    // 小数是从材料库带出来的（0.5 米这种），步进只加整数，不把小数抹掉
    const next = Math.min(MAX_QTY, Math.max(1, Number((base + step).toFixed(2))));
    rows[index] = { ...rows[index], qty: String(next) };
    this.setMaterialRows(rows);
  },

  /** 手填一行：仓库里根本没有这东西时用，只能走缺料登记 */
  onAddMaterialRow() {
    if (this.data.materialRows.length >= 10) return;
    this.setMaterialRows([...this.data.materialRows, emptyMaterialRow()]);
  },

  onRemoveMaterialRow(e: WechatMiniprogram.BaseEvent) {
    this.setMaterialRows(
      this.data.materialRows.filter((_, i) => i !== Number(e.currentTarget.dataset.index)),
    );
  },

  onMaterialNote(e: WechatMiniprogram.Input) {
    this.setData({ materialNote: e.detail.value });
  },

  // ---------------- 小区库存选择器 ----------------

  /** 不带 index = 新加一行（从库存挑），带 index = 给这一行换材料 */
  onOpenSku(e: WechatMiniprogram.BaseEvent) {
    const raw = e.currentTarget.dataset.index;
    const index = raw === undefined || raw === '' ? -1 : Number(raw);
    this.setData({ skuOpen: true, skuTargetIndex: index, skuKeyword: '', skuCategoryIndex: -1 });
    this.loadSkus();
  },

  onCloseSku() {
    this.setData({ skuOpen: false });
  },

  async loadSkus(force = false, warehouseId?: number) {
    if (this.allSkus.length && !force) {
      return this.applySkuFilter();
    }
    this.setData({ skuLoading: true, skuError: '' });
    try {
      const resp = await repairs.stockOptions(this.data.id, warehouseId);
      this.allSkus = resp.items;
      this.warehouseId = resp.warehouseId;
      // 类别筛选只列这个仓真有的类别：列一堆点了没结果的类别等于噪音
      const seen: string[] = [];
      resp.items.forEach((item) => {
        const name = (item.category || '').trim() || '未分类';
        if (!seen.includes(name)) seen.push(name);
      });
      // 旧版接口没有 warehouses（灰度期间可能撞上），当成「不能切」处理，别在这里炸
      const warehouses = resp.warehouses || [];
      const stocked = warehouses.filter((item) => item.hasStock && item.id !== resp.warehouseId);
      const typeText = resp.repairTypeLabel || '这个报修类型';
      this.setData({
        warehouseName: resp.warehouseName || '',
        skuTitle: resp.warehouseName ? `${resp.warehouseName}库存` : '未配领料仓库',
        skuWarehouseId: resp.warehouseId,
        warehouses,
        skuCategories: seen,
        skuCategoryIndex: -1,
        // 没仓 / 仓空都得说清是哪种，否则一屏「无货」看着就是坏了
        skuEmptyHint: !resp.warehouseId
          ? warehouses.length
            ? `本小区的「${typeText}」还没配领料仓库，让办公室在后台「报修类型配置」里配一下。急用先点上面「选仓库」自己挑一个。`
            : `本小区的「${typeText}」还没配领料仓库，公司也还没建仓，需要的料请走「手填一项」提报缺料。`
          : resp.items.every((item) => item.qty <= 0)
            ? stocked.length
              ? `「${resp.warehouseName}」里现在一件货都没有，点上面「换仓库」看看「${stocked[0].name}」`
              : `「${resp.warehouseName}」里现在一件货都没有，需要的料请走「手填一项」提报缺料`
            : '',
      });
      this.applySkuFilter();
    } catch (e: any) {
      this.setData({ skuError: e?.message || '库存加载失败' });
    } finally {
      this.setData({ skuLoading: false });
    }
  },

  onRetrySku() {
    this.loadSkus(true, this.warehouseId ?? undefined);
  },

  /**
   * 手动挑仓库。
   * 默认仓由后台「小区 + 报修类型」配好，配漏了 / 配的那个仓空了，
   * 维修工照样得能领到料 —— 不给这个口子，人就只能停在这儿等办公室。
   */
  onSwitchWarehouse() {
    const list = this.data.warehouses;
    if (!list.length) return;
    const names = list.map(
      (item) =>
        `${item.name}${item.own ? '（本类型默认）' : ''}${item.hasStock ? '' : '（暂无库存）'}`,
    );
    wx.showActionSheet({
      itemList: names,
      success: (res) => {
        const picked = list[res.tapIndex];
        if (!picked || picked.id === this.data.skuWarehouseId) return;
        this.allSkus = [];
        this.setData({ skuKeyword: '' });
        this.loadSkus(true, picked.id);
      },
      fail: () => {},
    });
  },

  onPickSkuCategory(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ skuCategoryIndex: this.data.skuCategoryIndex === index ? -1 : index }, () =>
      this.applySkuFilter(),
    );
  },

  applySkuFilter() {
    const kw = this.data.skuKeyword.trim().toLowerCase();
    const category =
      this.data.skuCategoryIndex >= 0 ? this.data.skuCategories[this.data.skuCategoryIndex] : '';
    const all = (this.allSkus as WorkOrderStockOption[]).filter(
      (item) => !category || ((item.category || '').trim() || '未分类') === category,
    );
    const matched = !kw
      ? all
      : all.filter((item: WorkOrderStockOption) =>
          [item.name, item.spec, item.code, item.category, ...(item.aliases || [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(kw),
        );
    // 有货的排前面：现场要的是「现在能拿到什么」，没货的沉到下面但仍然可选（选了走缺料）
    const list = matched
      .slice()
      .sort((a, b) => (b.qty > 0 ? 1 : 0) - (a.qty > 0 ? 1 : 0))
      .slice(0, 200);
    this.setData({ skuList: list });
  },

  onSkuKeyword(e: WechatMiniprogram.Input) {
    this.setData({ skuKeyword: e.detail.value }, () => this.applySkuFilter());
  },

  /** 照片单独点开看大图：光看缩略图分不清 DN50 和 DN75 */
  onPreviewSkuPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = e.currentTarget.dataset.url as string;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },

  onPickSku(e: WechatMiniprogram.BaseEvent) {
    const sku = this.data.skuList[Number(e.currentTarget.dataset.index)];
    if (!sku) return;
    const rows = this.data.materialRows.slice();
    const picked: MaterialRow = {
      ...emptyMaterialRow(),
      materialId: sku.materialId,
      name: sku.spec ? `${sku.name} ${sku.spec}` : sku.name,
      unit: sku.unit,
      photoUrl: sku.photoUrl || '',
      code: sku.code,
      stockQty: sku.qty,
      warehouseId: this.warehouseId,
    };
    const index = this.data.skuTargetIndex;
    if (index < 0 || !rows[index]) {
      rows.push(picked);
    } else {
      rows[index] = { ...picked, qty: rows[index].qty };
    }
    this.setData({ skuOpen: false });
    this.setMaterialRows(rows);
  },

  /**
   * 提报缺料：只把「仓里没有 / 不够」的那几行报上去。
   * 够用的料不该混进采购申请 —— 办公室会照单去买本来就有的东西。
   */
  async onSubmitMaterial() {
    const rows = collectRows(this.data.materialRows);
    if (!rows.length) {
      return this.setData({ materialError: '先添加至少一项材料' });
    }
    const bad = rows.find((row) => !Number.isFinite(row.qty) || row.qty <= 0);
    if (bad) {
      return this.setData({ materialError: `「${bad.name}」的数量要填大于 0 的数字` });
    }
    const shortage = rows.filter((row) => row.stockQty < 0 || row.qty > row.stockQty);
    if (!shortage.length) {
      return this.setData({
        materialError: '这些料仓库里都够用，直接完工提交即可，不用报缺料',
      });
    }

    this.setData({ busy: true, materialError: '' });
    try {
      await repairs.needMaterial(this.data.id, {
        missingMaterials: shortage.map((row) => ({
          materialId: row.materialId,
          name: row.name,
          // 仓里还有一些时只报差额：要 5 个、仓里有 2 个，采购买 3 个就行
          qty:
            row.stockQty > 0
              ? Math.max(1, Number((row.qty - row.stockQty).toFixed(2)))
              : row.qty,
          unit: row.unit,
        })),
        note: this.data.materialNote.trim() || undefined,
      });
      this.setData({ panel: '', materialNote: '' });
      this.setMaterialRows([]);
      wx.showToast({ title: '已提报，工单退回工单池' });
      // 这单已经不在自己手上了，留在详情页只会让人以为还能继续干，直接回工单池
      setTimeout(() => wx.switchTab({ url: '/pages/pool/pool' }), 900);
    } catch (e: any) {
      this.setData({ materialError: e?.message || '提报失败' });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 用料记好了就收起面板，等完工提交时随完工一起扣库存 */
  onConfirmMaterial() {
    const rows = collectRows(this.data.materialRows);
    const bad = rows.find((row) => !Number.isFinite(row.qty) || row.qty <= 0);
    if (bad) {
      return this.setData({ materialError: `「${bad.name}」的数量要填大于 0 的数字` });
    }
    this.setData({ panel: '' });
    if (rows.length) wx.showToast({ title: `已记 ${rows.length} 项用料` });
  },

  onFeeInput(e: WechatMiniprogram.Input) {
    this.setData({ feeYuan: e.detail.value, errorMsg: '' });
  },

  async onComplete() {
    const fee = this.data.feeYuan.trim();
    if (fee && (!Number.isFinite(Number(fee)) || Number(fee) < 0)) {
      return this.setData({ errorMsg: '收费金额填写不正确' });
    }
    // 从库存领的料才带 warehouseId：后端按它扣库存、记出库流水；
    // 用的是「这一行选中时所在的仓」——选料途中切过仓库，共用一个 id 会扣到别的仓去。
    // 手填的（仓里没有）不带，只留个名字在维修记录里
    const used = collectRows(this.data.materialRows)
      .filter((row) => Number.isFinite(row.qty) && row.qty > 0)
      .map((row) => ({
        materialId: row.materialId,
        warehouseId: row.materialId ? row.warehouseId ?? undefined : undefined,
        name: row.name,
        qty: row.qty,
        unit: row.unit,
      }));

    this.setData({ busy: true, errorMsg: '' });
    try {
      await repairs.complete(this.data.id, {
        actionNote: this.data.actionNote || undefined,
        repairContent: this.data.actionNote || undefined,
        faultLocation: this.data.faultLocation.trim() || undefined,
        faultSymptom: this.data.faultSymptom.trim() || undefined,
        feeCents: fee ? Math.round(Number(fee) * 100) : undefined,
        materials: used.length ? used : undefined,
        resultAttachments: this.data.resultAttachments,
      });
      wx.showToast({ title: '已提交，等待业主验收' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '提交失败' });
    } finally {
      this.setData({ busy: false });
    }
  },
});
