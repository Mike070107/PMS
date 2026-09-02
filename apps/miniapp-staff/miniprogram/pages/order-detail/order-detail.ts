import { ai, repairs, upload } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { askOrderSubscribe } from '../../utils/unread';
import {
  buildTimeline,
  createHoldToTalk,
  missingMaterialsText,
  speechErrorTip,
  statusLabel,
  type HoldToTalk,
  type TimelineRow,
} from '@pms/miniapp-ui';
import {
  formatDateTimeCn,
  REPAIR_TYPE_LABELS,
  stayDaysText,
  stayTone,
  stayDays,
  workOrderStatusText,
  WorkOrderStatus,
  type WorkOrderStockOption,
  type WorkOrderStockWarehouse,
  type WorkOrderDetail,
  type WorkOrderMaterialUsageView,
} from '@pms/shared-types';

/**
 * 「维修结果」那张卡：维修工提交完工时填的东西，办公室和业主要能看到。
 * 原来这一屏只画了报修信息 + 进度，完工填的故障位置、用料、收费、完修时间
 * 一个都没渲染 —— 单子到了「待验收」，点进去还是和没修一样，验收的人无从判断。
 */
interface ResultRow {
  label: string;
  value: string;
}

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
  /** SKU 规格单独保存，卡片首行按「名称 · 规格」展示；提交时再与名称合并 */
  spec: string;
  qty: string;
  unit: string;
  photoUrl: string;
  /** 这条 SKU 的全部实物照片；点开大图要给整组才能左右滑 */
  photoUrls: string[];
  code: string;
  /** 选中那一刻所在仓的可用量；手填的行为 -1（= 仓里没有这个 SKU） */
  stockQty: number;
  /** 从哪个仓领的（完工时按它扣库存）。手填的行为 null。
      必须一行一个：选料途中切过仓库，整单共用一个 warehouseId 就会扣错仓。 */
  warehouseId: number | null;
  /** 卡片上直接告诉维修工这份库存来自哪个仓，避免只看到一个孤零零的数量 */
  warehouseName: string;
  /** 这一项的备注（「原件锈死一并换掉」），会原样印到养护单背面的备注格 */
  note: string;
  /** 下面两个由 setMaterialRows 算好 —— wxml 里调不了函数 */
  hintText: string;
  hintShort: boolean;
}

/**
 * 完工小结的语音识别。走微信官方「同声传译」插件（只支持普通话），
 * 插件没装时 speechManager 一直是 null，「按住说话」整个按钮不显示，打字照常可用。
 */
let speechManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  speechManager = requirePlugin('WechatSI').getRecordRecognitionManager();
} catch {
  speechManager = null;
}

/** 按住说话的按压状态机，bindSpeech() 里创建；插件不可用时一直是 null */
let hold: HoldToTalk | null = null;

/** 数量默认 1：缺料十有八九就是缺一个，让人少点一下 */
const DEFAULT_QTY = '1';
const MAX_QTY = 999;

const compareStockOptionName = (a: WorkOrderStockOption, b: WorkOrderStockOption) =>
  a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  || (a.spec || '').localeCompare(b.spec || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  || a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const emptyMaterialRow = (): MaterialRow => ({
  materialId: null,
  name: '',
  spec: '',
  qty: DEFAULT_QTY,
  unit: '',
  photoUrl: '',
  photoUrls: [],
  code: '',
  stockQty: -1,
  warehouseId: null,
  warehouseName: '',
  note: '',
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
  const warehouse = row.warehouseName || '所选仓库';
  if (row.stockQty <= 0) {
    return { ...row, hintText: `${warehouse} · 无库存，需走缺料登记`, hintShort: true };
  }
  if (need > row.stockQty) {
    return {
      ...row,
      hintText: `${warehouse} · 只剩 ${row.stockQty}${row.unit}，不够，需走缺料登记`,
      hintShort: true,
    };
  }
  return { ...row, hintText: `${warehouse} · 可用 ${row.stockQty}${row.unit}`, hintShort: false };
}

/** 表单行 → 提交用的数组（去空行、数量转数字） */
function collectRows(rows: MaterialRow[]) {
  return rows
    .map((row) => ({
      materialId: row.materialId ?? undefined,
      name: [row.name.trim(), row.spec.trim()].filter(Boolean).join(' '),
      qty: Number(row.qty),
      unit: row.unit || undefined,
      stockQty: row.stockQty,
      warehouseId: row.warehouseId ?? undefined,
      note: row.note?.trim() || undefined,
    }))
    .filter((row) => row.name);
}

type CollectedMaterialRow = ReturnType<typeof collectRows>[number];

/**
 * 一行可能同时包含「现有库存」和「缺口」：例如要 5 个、仓里只有 2 个，
 * 就领用 2 个并提报缺 3 个。这里统一拆开，按钮文案和提交载荷使用同一口径。
 */
function splitMaterialRows(rows: CollectedMaterialRow[]) {
  const used: CollectedMaterialRow[] = [];
  const missing: CollectedMaterialRow[] = [];
  rows.forEach((row) => {
    if (!Number.isFinite(row.qty) || row.qty <= 0) return;
    const available =
      row.materialId && row.warehouseId && row.stockQty > 0
        ? Math.min(row.qty, row.stockQty)
        : 0;
    if (available > 0) used.push({ ...row, qty: available });
    const shortQty = Number((row.qty - available).toFixed(2));
    if (shortQty > 0) missing.push({ ...row, qty: shortQty });
  });
  return { used, missing };
}

interface PageData {
  id: string;
  detail: WorkOrderDetail | null;
  currentStatusText: string;
  typeLabel: string;
  createdAtText: string;
  /** 从业主提交那刻算起的停留天数，工单池里最该被看见的信息 */
  stayText: string;
  stayTone: string;
  /** 「报修时间」那一行日期后面的小标：「已等 3 天」 */
  stayBadge: string;
  /** 报修时说了「急修」，或压了 7 天以上：标题前挂「紧急」标签 */
  urgent: boolean;
  timeline: TimelineRow[];
  canAccept: boolean;
  canComplete: boolean;
  /** 缺料登记只在「维修中」开放：还没接单先接单，等待材料的单已经在池子里了 */
  canNeedMaterial: boolean;
  /** 已提报的缺料清单，等待材料时给接单的人看 */
  missingText: string;
  acceptText: string;
  /** 底部弹出的表单：'' 关闭 / material 缺料登记 / complete 完工提交 */
  panel: string;
  /** 进度默认只露最新一条，点开看全部。倒序，第 0 条就是最新的 */
  timelineOpen: boolean;
  /** 维修结果（完工后才有）：故障位置/现象、维修说明、用料、收费、完修时间 */
  resultRows: ResultRow[];
  resultMaterials: string[];
  resultPhotos: string[];
  hasResult: boolean;
  /** 「王师傅」/「未派单」 */
  assigneeText: string;
  contactPhone: string;
  resultAttachments: string[];
  actionNote: string;
  /* ---- 完工小结：按住说一句，大模型理成规范的维修记录 ---- */
  /** 微信同声传译插件在不在。不在就整个隐藏「按住说话」，打字照常可用 */
  hasSpeech: boolean;
  recording: boolean;
  /** 识别中的实时文字，让人知道在听 */
  partial: string;
  /** 正在让模型整理 */
  summarizing: boolean;
  /** 模型从话里听出的材料名 —— 只做提示，用料仍要自己从库存选 */
  materialHints: string[];
  /** AI 按真实收费规则给出的依据；金额仍可手工改，提交前必须由维修工确认 */
  feeSuggestionText: string;
  feeRuleCode: string;
  aiAssistTrace: { sourceText: string; draft: Record<string, unknown> } | null;
  faultLocation: string;
  faultSymptom: string;
  /** 收费金额（元，字符串便于输入）；提交时换算成分 */
  feeYuan: string;
  uploading: boolean;
  busy: boolean;
  errorMsg: string;
  /** 添加用料 */
  materialRows: Array<MaterialRow & { hintText: string; hintShort: boolean }>;
  /** 已经领用并实时扣库的用料，重新进单仍可见 */
  issuedMaterials: WorkOrderMaterialUsageView[];
  materialNote: string;
  materialError: string;
  /** 有一行库存不够或仓里没有 —— 面板底部要给「提报缺料」这条出路 */
  hasShortage: boolean;
  /** 至少有一部分可以立即从库存领用 */
  hasStockUsage: boolean;
  /** 根据全有货 / 全缺货 / 混合三种情况生成的唯一主按钮文案 */
  materialActionText: string;
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
  /** 面板标题：没仓时要写明「未匹配到仓库」，不能还挂着一个仓名 */
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
    currentStatusText: '',
    typeLabel: '',
    createdAtText: '',
    stayText: '',
    stayTone: 'normal',
    stayBadge: '',
    urgent: false,
    timeline: [],
    resultRows: [],
    resultMaterials: [],
    resultPhotos: [],
    hasResult: false,
    assigneeText: '未派单',
    canAccept: false,
    canComplete: false,
    canNeedMaterial: false,
    missingText: '',
    acceptText: '接单',
    panel: '',
    timelineOpen: false,
    contactPhone: '',
    resultAttachments: [],
    actionNote: '',
    /* ---- 完工小结：按住说一句，大模型理成规范的维修记录（2026-09-01 加） ----
       维修工是蹲在水管边单手拿手机，打字比说话慢十倍，「维修说明」常年只有「已修」两个字，
       回头对账、查保修全靠猜。语音走微信同声传译（只支持普通话），插件没装就隐藏按钮。 */
    hasSpeech: false,
    recording: false,
    /** 识别中的实时文字，让人知道在听 */
    partial: '',
    /** 正在让模型整理 */
    summarizing: false,
    /** 模型从话里听出的材料名 —— 只做提示，用料仍要自己从库存选（要扣的是具体 SKU） */
    materialHints: [] as string[],
    feeSuggestionText: '',
    feeRuleCode: '',
    aiAssistTrace: null,
    faultLocation: '',
    faultSymptom: '',
    feeYuan: '',
    uploading: false,
    busy: false,
    errorMsg: '',
    materialRows: [],
    issuedMaterials: [],
    materialNote: '',
    materialError: '',
    hasShortage: false,
    hasStockUsage: false,
    materialActionText: '记录用料',
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
    // Page 配置对象上的自定义字段可能跨页面实例残留，而 data 会恢复初始值。
    // 不清理就会出现「列表缓存还有、仓库 id 已空」的半旧状态，再打开选料只剩空面板。
    this.allSkus = [];
    this.warehouseId = null;
    this.setData({ id: q.id || '' });
    this.bindSpeech();
    this.load();
  },

  onBack() {
    wx.navigateBack();
  },

  async load() {
    if (!this.data.id) return;
    try {
      const [detail, session] = await Promise.all([
        repairs.detail(this.data.id),
        // 拿不到身份就当成「不是维修工」：宁可少给一个按钮（详情仍然能看），
        // 也不要画一个点下去必然 403 的接单按钮
        getSession(this).catch(() => null),
      ]);
      const status = detail.workOrder.status;
      const timelineLabels = {
        ...statusLabel,
        [WorkOrderStatus.CREATED]: detail.workOrder.candidateIds?.length ? '待接单' : '待派单',
      };
      const myId = session?.me?.id ?? 0;
      // 缺料提报后工单会退回工单池（assigneeId 置空），所以「等待材料 + 没人认领」
      // 要给的是接单按钮而不是完工表单。存量数据里还有挂着人的等待材料单，那种仍按在手工单处理。
      const waitingInPool =
        status === WorkOrderStatus.WAITING_MATERIAL && !detail.workOrder.assigneeId;
      // 停留天数算一次给三处用（文案、色调、紧急标）——原来同一段表达式抄了两遍
      const stayedDays = stayDays(
        detail.workOrder.createdAt,
        detail.workOrder.completedAt ? new Date(detail.workOrder.completedAt) : new Date(),
      );
      this.setData({
        detail,
        currentStatusText: workOrderStatusText(status, detail.workOrder.candidateIds),
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
        stayTone: stayTone(stayedDays),
        // 和列表卡片同一句式：日期黑色，只有「已等 N 天」跟着状态上色
        stayBadge: `已等 ${stayedDays} 天`,
        // 和列表卡片同一口径：报单时说了「急修」，或者压了 7 天，都挂红标
        urgent: !!detail.request?.urgent || stayTone(stayedDays) === 'danger',
        timeline: buildTimeline(detail.logs, timelineLabels, { finished: [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED].indexOf(status) >= 0 }),
        // 工单池内未开工的单都可主动接：未派人、派给自己或派给别人都一样。
        // 权限由 session.canAccept 管，小区范围和并发抢单由后端再兜底。
        canAccept:
          !!session?.canAccept &&
          (status === WorkOrderStatus.CREATED ||
            status === WorkOrderStatus.DISPATCHED ||
            waitingInPool),
        // 完工/缺料同理：只有这单真在自己手上才给表单
        canComplete:
          !!session?.canHandleOrders &&
          detail.workOrder.assigneeId === myId &&
          (status === WorkOrderStatus.IN_PROGRESS ||
            (status === WorkOrderStatus.WAITING_MATERIAL && !waitingInPool)),
        canNeedMaterial:
          !!session?.canHandleOrders &&
          detail.workOrder.assigneeId === myId &&
          status === WorkOrderStatus.IN_PROGRESS,
        assigneeText: detail.workOrder.assigneeName || '未派单',
        ...this.buildResult(detail),
        missingText: missingMaterialsText(detail.workOrder.missingMaterials),
        acceptText: waitingInPool
          ? '材料到了，接回'
          : detail.workOrder.assigneeId && detail.workOrder.assigneeId !== myId
            ? '主动接单'
            : '接单',
        contactPhone: detail.request?.contactPhone || '',
        issuedMaterials: detail.materialUsages || [],
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

  /**
   * 完工填的那些东西 → 详情页「维修结果」卡片。
   *
   * 只列真有值的行：一屏「故障位置：—、收费：—」全是破折号，比不显示还难读。
   * 一行都没有时整张卡不出现（hasResult=false）—— 还没修完的单本来就没有结果。
   */
  buildResult(detail: WorkOrderDetail) {
    const wo = detail.workOrder;
    const rows: ResultRow[] = [];
    const push = (label: string, value?: string | null) => {
      const text = (value ?? '').toString().trim();
      if (text) rows.push({ label, value: text });
    };

    push('故障位置', wo.faultLocation);
    push('故障现象', wo.faultSymptom);
    // 维修说明两个字段是同一件事的历史遗留：后台走 repairContent，小程序走 actionNote，
    // 哪个有值用哪个，不要两行都画出来
    push('维修说明', wo.actionNote || wo.repairContent);
    if (wo.feeCents > 0) push('收费金额', `¥${(wo.feeCents / 100).toFixed(2)}`);
    else if (wo.completedAt) push('收费金额', '未收费');
    push('完修时间', wo.completedAt ? formatDateTimeCn(wo.completedAt) : '');
    // 「维修工」不在这里重复：上面那张报修卡已经有一行，同一个值在一屏出现两次
    // 只会让人怀疑是不是两个不同的人

    const materials = (wo.usedMaterials || [])
      .filter((item) => item && (item.name || item.qty))
      .map((item) => `${item.name || '未命名材料'} ×${item.qty}${item.unit || ''}`);
    const photos = wo.resultAttachments || [];

    return {
      resultRows: rows,
      resultMaterials: materials,
      resultPhotos: photos,
      hasResult: rows.length > 0 || materials.length > 0 || photos.length > 0,
    };
  },

  /** 完工照片点开看大图：缩略图上看不出修没修好 */
  onPreviewResultImage(e: WechatMiniprogram.BaseEvent) {
    const urls = this.data.resultPhotos || [];
    if (!urls.length) return;
    wx.previewImage({ current: e.currentTarget.dataset.url, urls });
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
      wx.showToast({ title: '已接单，正在打开在手工单', icon: 'none', duration: 900 });
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      await new Promise<void>((resolve) => {
        wx.switchTab({
          url: '/pages/my-orders/my-orders',
          success: () => resolve(),
          fail: () => resolve(),
        });
      });
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
      // 显式要压缩图，别靠微信默认值
      .chooseMedia({
        count: 6,
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

  // ---------------- 完工小结：说一句，模型理成维修记录 ----------------

  bindSpeech() {
    if (!speechManager) return;
    this.setData({ hasSpeech: true });
    hold = createHoldToTalk(speechManager);
    speechManager.onStart = () => {
      this.setData({ recording: true, partial: '' });
      // 首次授权时 touchend 被授权框吃掉，这里替它补 stop（见 createHoldToTalk 的注释）
      hold?.started();
    };
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ partial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      hold?.ended();
      const text = (res.result || this.data.partial || '').trim();
      this.setData({ recording: false, partial: '' });
      if (text) this.summarize(text);
    };
    speechManager.onError = (err: { msg?: string; retcode?: number }) => {
      hold?.ended();
      this.setData({ recording: false, partial: '' });
      speechErrorTip(err).then((tip) => wx.showToast({ icon: 'none', title: tip }));
    };
  },

  onStartRecord() {
    hold?.press();
  },

  /** touchend 和 touchcancel 都指到这里：手指滑出按钮、被来电打断也要收尾 */
  onStopRecord() {
    hold?.release();
  },

  /**
   * 把口述交给模型整理成维修记录。
   *
   * **整理不成也要有结果**：没配大模型、调不通、超时时，把原话原样接到「维修说明」后面 ——
   * 他话已经说完了，总不能让它凭空消失，宁可格式糙一点。
   * 位置和现象只在原来空着时才填，不覆盖他手工改过的内容。
   * 用料一律不自动填：模型听出的名字和库存 SKU 常对不上（2026-09-02 反馈：
   * 「角阀」「弯头」这类口语名跟材料库里的规范名不匹配），只把名字列出来提醒他
   * 去「添加用料」里手动核对、从库存选，不直接塞进用料行。
   */
  async summarize(text: string) {
    this.setData({ summarizing: true });
    const fallback = () => {
      const next = [this.data.actionNote.trim(), text].filter(Boolean).join('；');
      this.setData({ actionNote: next }, () => this.syncPhraseState());
    };
    try {
      const res = await ai.completionSummary({ text, workOrderId: Number(this.data.id) });
      if (!res?.ok || !res.actionNote) {
        fallback();
        return;
      }
      const patch: Record<string, unknown> = {
        actionNote: [this.data.actionNote.trim(), res.actionNote].filter(Boolean).join('；'),
        materialHints: res.materials || [],
      };
      if (!this.data.faultLocation && res.faultLocation) patch.faultLocation = res.faultLocation;
      if (!this.data.faultSymptom && res.faultSymptom) patch.faultSymptom = res.faultSymptom;
      if (!this.data.feeYuan && res.feeSuggestion) {
        patch.feeYuan = String(res.feeSuggestion.feeCents / 100);
        patch.feeRuleCode = res.feeSuggestion.ruleCode;
        patch.feeSuggestionText = `${res.feeSuggestion.basis}，请核对`;
      }
      const previousTrace = this.data.aiAssistTrace;
      patch.aiAssistTrace = {
        sourceText: [previousTrace?.sourceText, text].filter(Boolean).join('；'),
        draft: {
          ...(res.draft || {}),
          actionNote: patch.actionNote,
          faultLocation: patch.faultLocation ?? this.data.faultLocation,
          faultSymptom: patch.faultSymptom ?? this.data.faultSymptom,
          materials: [...new Set([...(this.data.materialHints || []), ...(res.materials || [])])],
          feeRuleCode: patch.feeRuleCode ?? this.data.feeRuleCode,
        },
      };
      this.setData(patch, () => this.syncPhraseState());
      await this.applyAiMaterialSuggestions(res.materialSuggestions || []);
    } catch {
      fallback();
    } finally {
      this.setData({ summarizing: false });
    }
  },

  /**
   * 只有“口语名唯一精确命中材料名称/别名 + 数量明确”才形成用料草稿行。
   * 模糊命中仍只显示提示，库存仓、SKU、数量任一不确定都不替维修工做决定。
   */
  async applyAiMaterialSuggestions(
    suggestions: Array<{
      spokenName: string;
      qty: number | null;
      materialId: number | null;
      match: string;
      needsConfirmation: boolean;
    }>,
  ) {
    const exact = suggestions.filter(
      (item) => item.match === 'exact' && !item.needsConfirmation && item.materialId && item.qty,
    );
    if (!exact.length) return;
    try {
      const resp = await repairs.stockOptions(this.data.id);
      if (!resp.warehouseId) return;
      const existing = new Set(
        this.data.materialRows.map((row) => row.materialId).filter((id): id is number => !!id),
      );
      const rows = this.data.materialRows.slice();
      exact.forEach((suggestion) => {
        if (!suggestion.materialId || existing.has(suggestion.materialId)) return;
        const sku = resp.items.find((item) => item.materialId === suggestion.materialId);
        if (!sku) return;
        rows.push({
          ...emptyMaterialRow(),
          materialId: sku.materialId,
          name: sku.name,
          spec: sku.spec || '',
          qty: String(suggestion.qty),
          unit: sku.unit,
          photoUrl: sku.photoUrl || '',
          photoUrls: (sku.photoUrls?.length ? sku.photoUrls : [sku.photoUrl || '']).filter(Boolean),
          code: sku.code,
          stockQty: sku.qty,
          warehouseId: resp.warehouseId,
          warehouseName: resp.warehouseName,
        });
        existing.add(sku.materialId);
      });
      if (rows.length !== this.data.materialRows.length) this.setMaterialRows(rows);
    } catch {
      // 自动匹配只是省点击；失败时保留材料文字提示，让维修工手工选，不阻断完工。
    }
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
    const parts = splitMaterialRows(collectRows(decorated));
    const hasStockUsage = parts.used.length > 0;
    const hasShortage = parts.missing.length > 0;
    this.setData({
      materialRows: decorated,
      hasShortage,
      hasStockUsage,
      materialActionText:
        hasStockUsage && hasShortage
          ? '有库存记用料，没库存提报缺料'
          : hasShortage
            ? '提报缺料'
            : '记录用料',
      materialError: '',
    });
  },

  onMaterialInput(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field as 'name' | 'qty' | 'note';
    const rows = this.data.materialRows.slice();
    rows[index] = { ...rows[index], [field]: e.detail.value };
    // 名称一旦被手改，就不再是库存里那一项了：关联 id 必须跟着摘掉，
    // 否则完工时按 id 扣的是另一样东西，而办公室看到的名字还是维修工写的这个。
    if (field === 'name') {
      rows[index].materialId = null;
      rows[index].spec = '';
      rows[index].unit = '';
      rows[index].photoUrl = '';
      rows[index].photoUrls = [];
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

  /** 已领用的料不是端上草稿：删除要走服务端退库，不能只从界面上抹掉。 */
  onRemoveIssuedMaterial(e: WechatMiniprogram.BaseEvent) {
    const usageId = Number(e.currentTarget.dataset.id);
    const row = this.data.issuedMaterials.find((item) => item.id === usageId);
    if (!row || this.data.busy) return;
    wx.showModal({
      title: '删除并退回库存？',
      content: `${row.name} ×${row.qty}${row.unit || ''}将退回${row.warehouseName}，并留一条退料流水。`,
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true, materialError: '' });
        try {
          await repairs.removeUsedMaterial(this.data.id, usageId);
          wx.showToast({ title: '已删除并退库' });
          await this.load();
        } catch (error: any) {
          this.setData({ materialError: error?.message || '退料失败' });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
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
    if (
      this.allSkus.length &&
      !force &&
      this.warehouseId !== null &&
      this.data.skuWarehouseId === this.warehouseId
    ) {
      return this.applySkuFilter();
    }
    this.setData({ skuLoading: true, skuError: '' });
    try {
      const resp = await repairs.stockOptions(this.data.id, warehouseId);
      this.allSkus = resp.items;
      this.warehouseId = resp.warehouseId;
      // 类别筛选只列这个仓真有的类别：列一堆点了没结果的类别等于噪音
      const seen: string[] = [];
      resp.items.filter((item) => item.qty > 0).forEach((item) => {
        const name = (item.category || '').trim() || '未分类';
        if (!seen.includes(name)) seen.push(name);
      });
      // 旧版接口没有 warehouses（灰度期间可能撞上），当成「不能切」处理，别在这里炸
      const warehouses = resp.warehouses || [];
      const stocked = warehouses.filter((item) => item.hasStock && item.id !== resp.warehouseId);
      const typeText = resp.repairTypeLabel || '这个报修类型';
      this.setData({
        warehouseName: resp.warehouseName || '',
        skuTitle: resp.warehouseName ? `${resp.warehouseName}库存` : '未匹配到仓库',
        skuWarehouseId: resp.warehouseId,
        warehouses,
        skuCategories: seen,
        skuCategoryIndex: -1,
        // 没仓 / 仓空都得说清是哪种，否则一屏「无货」看着就是坏了
        // 仓库按工单所在小区 / 管理处自动匹配（同小区仓 → 同管理处仓 → 公司总仓），
        // 匹配不到 = 仓都挂在别的管理处名下：请办公室在「库存与采购」给本管理处建仓，急用自己挑
        skuEmptyHint: !resp.warehouseId
          ? warehouses.length
            ? `本单所在的小区 / 管理处还没有自己的仓库，公司也没有总仓。急用先点上面「选仓库」自己挑一个；请办公室在后台「库存与采购」里给本管理处建仓。`
            : `公司还没建任何仓库，「${typeText}」需要的料请走「手填一项」提报缺料。`
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
   * 默认仓按工单所在小区 / 管理处自动匹配，匹配不到 / 匹配到的那个仓空了，
   * 维修工照样得能领到料 —— 不给这个口子，人就只能停在这儿等办公室。
   */
  onSwitchWarehouse() {
    const list = this.data.warehouses;
    if (!list.length) return;
    const names = list.map(
      (item) =>
        `${item.name}${item.own ? '（本单默认）' : ''}${item.hasStock ? '' : '（暂无库存）'}`,
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
    // 默认只给现场看拿得到的货；开始搜索后扩大到整个材料库，0 库存 SKU 也能选来报缺料。
    const source = kw
      ? (this.allSkus as WorkOrderStockOption[])
      : (this.allSkus as WorkOrderStockOption[]).filter((item) => item.qty > 0);
    const all = source.filter(
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
    const list = matched.slice().sort(compareStockOptionName).slice(0, 200);
    this.setData({ skuList: list });
  },

  onSkuKeyword(e: WechatMiniprogram.Input) {
    const skuKeyword = e.detail.value;
    // 搜索要覆盖全材料库，不能被刚才点过的「有货类别」悄悄挡住。
    this.setData({ skuKeyword, skuCategoryIndex: skuKeyword.trim() ? -1 : this.data.skuCategoryIndex }, () =>
      this.applySkuFilter(),
    );
  },

  /**
   * 照片点开看大图。urls 给整组才能左右滑 —— 一条 SKU 有正面/侧面/铭牌/包装，
   * 只给当前这张的话，现场想看铭牌确认型号就滑不出来。
   */
  onPreviewSkuPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    const list = urls.length ? urls : url ? [url] : [];
    if (!list.length) return;
    wx.previewImage({ current: url || list[0], urls: list });
  },

  onPickSku(e: WechatMiniprogram.BaseEvent) {
    const sku = this.data.skuList[Number(e.currentTarget.dataset.index)];
    if (!sku) return;
    const rows = this.data.materialRows.slice();
    const picked: MaterialRow = {
      ...emptyMaterialRow(),
      materialId: sku.materialId,
      name: sku.name,
      spec: sku.spec || '',
      unit: sku.unit,
      photoUrl: sku.photoUrl || '',
      photoUrls: (sku.photoUrls && sku.photoUrls.length ? sku.photoUrls : [sku.photoUrl || '']).filter(Boolean),
      code: sku.code,
      stockQty: sku.qty,
      warehouseId: this.warehouseId,
      warehouseName: this.data.warehouseName,
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
    const { used, missing: shortage } = splitMaterialRows(rows);
    if (!shortage.length) {
      return this.setData({
        materialError: '这些料仓库里都够用，直接完工提交即可，不用报缺料',
      });
    }

    this.setData({ busy: true, materialError: '' });
    try {
      await repairs.needMaterial(this.data.id, {
        usedMaterials: used.map((row) => ({
          materialId: row.materialId,
          warehouseId: row.warehouseId,
          name: row.name,
          qty: row.qty,
          unit: row.unit,
          note: row.note,
        })),
        missingMaterials: shortage.map((row) => ({
          materialId: row.materialId,
          warehouseId: row.materialId ? row.warehouseId ?? undefined : undefined,
          name: row.name,
          qty: row.qty,
          unit: row.unit,
        })),
        note: this.data.materialNote.trim() || undefined,
      });
      this.setData({ panel: '', materialNote: '' });
      this.setMaterialRows([]);
      const orderNo = this.data.detail?.workOrder.orderNo || '';
      wx.setStorageSync('pms.staff.open_order', JSON.stringify({ mainTab: 'pool', status: 'waiting', orderNo }));
      wx.showModal({
        title: '已转等待材料',
        content: `${orderNo || '该工单'}${used.length ? '的有库存用料已扣减，' : ''}缺料已生成采购申请。可在工单池的「等待材料」中找到。`,
        showCancel: false,
        confirmText: '去看工单',
        success: () => wx.switchTab({ url: '/pages/pool/pool' }),
      });
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

  /** 底部只保留一个主按钮，根据材料构成选择「记录」或「提报并记录」 */
  onMaterialPrimaryAction() {
    if (this.data.hasShortage) {
      this.onSubmitMaterial();
      return;
    }
    this.onConfirmMaterial();
  },

  onFeeInput(e: WechatMiniprogram.Input) {
    this.setData({
      feeYuan: e.detail.value,
      feeRuleCode: '',
      feeSuggestionText: '',
      errorMsg: '',
    });
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
        note: row.note,
      }));

    // 刚干完一单，正等着下一单 —— 这时补订阅额度同意率最高。
    // 必须在这次点击里同步发起，放到 complete 请求之后微信就不认了（见 utils/unread.ts）
    askOrderSubscribe();
    this.setData({ busy: true, errorMsg: '' });
    try {
      await repairs.complete(this.data.id, {
        actionNote: this.data.actionNote || undefined,
        repairContent: this.data.actionNote || undefined,
        faultLocation: this.data.faultLocation.trim() || undefined,
        faultSymptom: this.data.faultSymptom.trim() || undefined,
        feeCents: fee ? Math.round(Number(fee) * 100) : undefined,
        feeRuleCode: this.data.feeRuleCode || undefined,
        aiAssist: this.data.aiAssistTrace || undefined,
        materials: used.length ? used : undefined,
        resultAttachments: this.data.resultAttachments,
      });
      const orderNo = this.data.detail?.workOrder.orderNo || '';
      wx.setStorageSync('pms.staff.open_order', JSON.stringify({ mainTab: 'done', orderNo }));
      wx.showModal({
        title: '已提交完工',
        content: `${orderNo || '该工单'}已进入待验收，可在工单池的「已完结」里回看刚填的内容。`,
        showCancel: false,
        confirmText: '去看工单',
        success: () => wx.switchTab({ url: '/pages/pool/pool' }),
      });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '提交失败' });
    } finally {
      this.setData({ busy: false });
    }
  },
});
