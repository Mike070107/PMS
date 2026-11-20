import { dedupeAddressText, formatBeijingDateTime } from '@pms/shared-types';
/**
 * 公寓收费工作台（员工端）。
 *
 * 和网站后台「收费业务 → 公寓收费工作台」是同一套接口、同一份费用清单
 * （@pms/shared-types 的 APARTMENT_FEE_TYPES）和同一套地址写法（placeLabel），
 * 不是另做一个平行实现 —— 两端小票上的项目名、单位、地址必须一模一样。
 *
 * 手机上做了两处收敛：
 *   · 选址用原生 picker（小区 → 楼栋 → 房号），不做联想搜索；公寓楼栋房号本来就少；
 *   · 打印和补打使用员工获授权的现场打印机。红冲仍在电脑上办理；
 *     这一页只管「收一笔、出一张」和「查这间房交过什么」。
 */
import { apartmentCashier } from '@pms/api-client';
// 这几个类型挂在 apartmentCashier 这个命名空间下（api-client 用的是 export * as）
type CashierCommunity = apartmentCashier.CashierCommunity;
type CashierBuilding = apartmentCashier.CashierBuilding;
type CashierHouse = apartmentCashier.CashierHouse;
import {
  APARTMENT_FEE_TYPES,
  FEE_PAYMENT_METHOD_LABELS,
  buildingLabel,
  cashierQuantityFromAmount,
  cashierServicePeriodError,
  formatFeeMoney,
  placeLabel,
  roomLabel,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';
import { guideHandlers } from '../../utils/guide';
import { rememberAccess, syncTabBar } from '../../utils/tabbar';

/** 手机上只给这三种真的会在现场用到的收款方式 */
const PAYMENT_METHODS = [
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
  { value: 'cash', label: '现金' },
];

interface FeeRow {
  feeCode: string;
  feeName: string;
  unit: string;
  quantity: number;
  /** 输入框里显示的元（字符串，避免 input 把「1.」吃掉） */
  quantityText: string;
  unitPriceYuan: string;
  amountYuan: string;
  amountCents: number;
  priceHint?: string;
  vehiclePlate?: string;
  serviceFrom?: string;
  serviceTo?: string;
}

/** 元（用户输入的文本）→ 分。空串、乱填一律当 0，不让 NaN 流进金额 */
function yuanToCents(text: string): number {
  const value = Number(String(text).replace(/[^\d.]/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function numberOf(text: string): number {
  const value = Number(String(text).replace(/[^\d.]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

Page({
  ...guideHandlers(),
  data: {
    guide: false,
    loading: true,
    /** 没有这一格权限的人不该停在这页上 */
    canSeeCashier: true,
    canCharge: false,
    error: '',

    communities: [] as CashierCommunity[],
    communityNames: [] as string[],
    communityIndex: -1,

    buildings: [] as CashierBuilding[],
    buildingNames: [] as string[],
    buildingIndex: -1,
    loadingBuildings: false,

    houses: [] as CashierHouse[],
    houseNames: [] as string[],
    houseIndex: -1,
    loadingHouses: false,

    /** 当前房间（选完才有） */
    placeText: '',
    fullPlaceText: '',
    communityText: '',
    ownerName: '',
    ownerPhone: '',
    contactSaving: false,
    contactError: '',
    contactStatus: '',
    activeTab: 'charge' as 'charge' | 'history' | 'today',
    todayDetailsExpanded: false,
    todaySummaryLoading: false,
    todaySummaryError: '',

    /** 可点的费用按钮 */
    feeTypes: APARTMENT_FEE_TYPES.map((item) => ({ ...item, active: false })),
    rows: [] as FeeRow[],
    totalText: formatFeeMoney(0),
    totalCents: 0,
    ratesLoading: false,
    ratesError: '',

    paymentMethods: PAYMENT_METHODS,
    paymentMethod: '',
    remark: '',
    submitting: false,
    submitError: '',

    /** 收完款弹出的小票 */
    recordNo: '',
    recordError: '',
    recordDetail: null as ReturnType<typeof detailView> | null,
    receiptOpen: false,
    receiptNo: '',
    printAvailable: false,
    printListError: '',
    printBusy: false,
    receiptItems: [] as Array<{ feeName: string; qtyText: string; amountText: string; vehiclePlate?:string; serviceFrom?:string; serviceTo?:string }>,
    receiptAmountText: '',

    todayLoading: false,
    todayLoaded: false,
    todayError: '',
    todayRows: [] as Array<CashierRecordView & { key: string; placeText: string }>,
    todayPage: 0,
    todayDate: '',
    todayTotal: 0,
    todayAmountText: '',
    historyLoading: false,
    historyError: '',
    historyPage: 0,
    historyTotal: 0,
    history: [] as CashierRecordView[],
  },

  onShow() {
    this.syncGuide();
    if (!this.data.loading && this.data.canSeeCashier) void this.refreshPrinters();
    syncTabBar(this, 'cashier');
    if (!this.data.loading && this.data.canSeeCashier && this.data.activeTab === 'today') void this.onRefreshToday();
  },

  async onPullDownRefresh() {
    try {
      if (!this.data.loading && this.data.canSeeCashier) {
        const house = this.data.houses[this.data.houseIndex];
        if (this.data.activeTab === 'today') await this.onRefreshToday();
        else if (this.data.activeTab === 'history' && house) await this.loadHistory(house.id);
      }
    } finally { wx.stopPullDownRefresh(); }
  },

  async onLoad() {
    try {
      const session = await getSession();
      rememberAccess(this, session.me?.access?.pages);
      syncTabBar(this, 'cashier');
      if (!session.canSeeCashier) {
        this.setData({ canSeeCashier: false, loading: false });
        return;
      }
      this.setData({ canCharge: session.canCharge });
      void this.refreshPrinters();
      const rows = await apartmentCashier.communities();
      // 他的数据范围只有一个小区时，那就是「他自己的小区」，直接选上。
      // 范围是多个（或全公司）时不替他猜，让他自己点。
      const scoped = session.me?.access?.communityIds || [];
      const mine = scoped.length ? rows.filter((item) => scoped.indexOf(item.id) >= 0) : rows;
      this.communityPreferenceKey=session.me?.id ? `pms.apartment.community:${session.me.tenantId}:${session.me.id}` : '';
      this.setData({communities:mine,communityNames:mine.map(item=>item.name),loading:false});
      let remembered:unknown;
      try{if(this.communityPreferenceKey)remembered=wx.getStorageSync(this.communityPreferenceKey);}catch{/* preference is optional */}
      const preferred=mine.length===1?0:mine.findIndex(item=>item.id===remembered);
      if(preferred>=0)await this.pickCommunity(preferred);
    } catch (e: any) {
      this.setData({ loading: false, error: e?.message || '小区加载失败，下拉重试或稍后再进来' });
    }
  },

  // ---------------- 选址 ----------------

  onPickCommunity(e: WechatMiniprogram.PickerChange) {
    void this.pickCommunity(Number(e.detail.value));
  },

  communityPreferenceKey: '',

  async pickCommunity(index: number) {
    if(this.data.submitting || !(await this.saveContact()))return;
    const community = this.data.communities[index];
    if (!community) return;
    try{if(this.communityPreferenceKey)wx.setStorageSync(this.communityPreferenceKey,community.id);}catch{/* 不影响正常选房 */}
    this.setData({
      communityIndex: index,
      communityText: community.name,
      buildings: [],
      buildingNames: [],
      buildingIndex: -1,
      loadingBuildings: true,
      ...this.clearedHouse(),
    });
    try {
      const rows = await apartmentCashier.buildings(community.id);
      this.setData({
        buildings: rows,
        buildingNames: rows.map((item) => buildingLabel(item.buildingNo)),
        loadingBuildings: false,
      });
      if (rows.length === 1) await this.pickBuilding(0);
    } catch (e: any) {
      this.setData({ loadingBuildings: false });
      wx.showToast({ icon: 'none', title: e?.message || '楼栋加载失败' });
    }
  },

  onPickBuilding(e: WechatMiniprogram.PickerChange) {
    void this.pickBuilding(Number(e.detail.value));
  },

  async pickBuilding(index: number) {
    if(this.data.submitting || !(await this.saveContact()))return;
    const building = this.data.buildings[index];
    if (!building) return;
    this.setData({ buildingIndex: index, loadingHouses: true, ...this.clearedHouse() });
    try {
      const rows = await apartmentCashier.houses(building.id);
      this.setData({
        houses: rows,
        houseNames: rows.map((item) => roomLabel(item.roomNo)),
        loadingHouses: false,
      });
    } catch (e: any) {
      this.setData({ loadingHouses: false });
      wx.showToast({ icon: 'none', title: e?.message || '房号加载失败' });
    }
  },

  onPickHouse(e: WechatMiniprogram.PickerChange) {
    void this.pickHouse(Number(e.detail.value));
  },

  /** 选中房号：带出业主姓名电话（存量旧地址已经进了业主档案），预填单价，拉历史 */
  async pickHouse(index: number) {
    if(this.data.submitting || !(await this.saveContact()))return;
    const house = this.data.houses[index];
    if (!house) return;
    ++this.historyRequest;
    const lane = this.data.buildings[this.data.buildingIndex]?.lane;
    this.setData({
      houseIndex: index,
      fullPlaceText: dedupeAddressText([house.communityName || this.data.communityText, lane && /^\d+$/.test(lane) ? `${lane}弄` : lane, placeLabel(house.buildingNo, house.roomNo)].filter(Boolean).join(' ')),
      contactStatus: '', contactError: '',
      history: [], historyPage: 0, historyTotal: 0, historyLoading: false, historyError: '',
      placeText: placeLabel(house.buildingNo, house.roomNo),
      ownerName: house.owner?.name || '',
      ownerPhone: house.owner?.phone || '',
      rows: [],
      feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: false })),
      paymentMethod: '',
      remark: '',
      submitError: '',
    });
    this.recount([]);
    await Promise.all([this.loadRates(house.id), ...(this.data.activeTab === 'history' ? [this.loadHistory(house.id)] : [])]);
  },

  /** 换楼栋 / 换小区时，房间和这一单全部清掉 —— 不能把上一间的费用带过去 */
  clearedHouse() {
    ++this.ratesRequest;
    ++this.historyRequest;
    this.rates={};this.rateMeta={};this.rateQuote=undefined;this.ratesDraftInvalidated=false;
    return {
      ratesLoading:false,ratesError:'',
      houses: [] as CashierHouse[],
      houseNames: [] as string[],
      houseIndex: -1,
      placeText: '',
      fullPlaceText: '',
      ownerName: '',
      ownerPhone: '',
      contactStatus: '', contactError: '', contactSaving: false,
      rows: [] as FeeRow[],
      feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: false })),
      paymentMethod: '',
      remark: '',
      submitError: '',
      totalCents: 0,
      totalText: formatFeeMoney(0),
      history: [], historyLoading: false, historyError: '', historyPage: 0, historyTotal: 0,
    };
  },

  get currentHouse(): CashierHouse | undefined {
    return this.data.houses[this.data.houseIndex];
  },

  // ---------------- 单价与历史 ----------------

  rates: {} as Record<string, number>,
  rateMeta: {} as Record<string,{unit?:string;calculation?:string;cycle?:string}>,
  rateQuote: undefined as string | null | undefined,
  ratesRequest: 0,
  ratesDraftInvalidated: false,

  async loadRates(houseId: number) {
    const requestId=++this.ratesRequest;
    if(this.data.rows.length){this.ratesDraftInvalidated=true;this.replaceRows([]);}
    this.rates = {};this.rateMeta={};
    this.rateQuote=undefined;
    this.setData({ratesLoading:true,ratesError:''});
    try {
      const data = await apartmentCashier.standards(houseId);
      if(requestId!==this.ratesRequest)return;
      if(data.rateQuote!==null && typeof data.rateQuote!=='string')throw new Error('收费标准版本缺失，请重试');
      const map: Record<string, number> = {};
      for (const item of data.standards || []) {
        if (item.status === 'active') {
          if(!Number.isSafeInteger(item.amountCents)||item.amountCents<0||Object.prototype.hasOwnProperty.call(map,item.feeCode))throw new Error('收费标准金额无效或项目重复，请核对配置');
          map[item.feeCode] = item.amountCents;
          this.rateMeta[item.feeCode]={unit:item.unit,calculation:item.calculation,cycle:item.cycle};
        }
      }
      this.rates = map;this.rateQuote=data.rateQuote;
      this.setData({ratesLoading:false,ratesError:this.ratesDraftInvalidated?'收费标准已重新读取，请重新选择收费项目并核对金额':''});
    } catch (e: any) {
      if(requestId!==this.ratesRequest)return;
      this.setData({ratesLoading:false,ratesError:e?.message || '收费标准读取失败，请重试'});
    }
  },

  async onRetryRates() {
    if(this.data.submitting)return;
    const house=this.data.houses[this.data.houseIndex];
    if(house)await this.loadRates(house.id);
  },

  historyRequest: 0,
  historyHouseId: 0,
  async loadHistory(houseId: number, page = 1): Promise<void> {
    const requestId = ++this.historyRequest;
    const changedHouse = this.historyHouseId !== houseId;
    this.historyHouseId = houseId;
    this.setData({ historyLoading: true, historyError: '', ...(changedHouse ? { history: [], historyPage: 0, historyTotal: 0 } : {}) });
    try {
      const data = await apartmentCashier.history(houseId, page);
      if (requestId !== this.historyRequest) return;
      // offset分页期间有新收费时回到第一页，避免同笔重复或漏项。
      if (page > 1 && data.total !== this.data.historyTotal) return this.loadHistory(houseId);
      const records = [...(page > 1 ? this.data.history : []), ...(data.rows || []).map(recordView)];
      this.setData({
        historyLoading: false, historyPage: page, historyTotal: data.total,
        history: records.filter((row, index) => records.findIndex((item) => item.receiptNo === row.receiptNo) === index),
      });
    } catch (e: any) {
      if (requestId !== this.historyRequest) return;
      this.setData({ historyLoading: false, historyError: e?.message || '历史缴费加载失败，请重试' });
    }
  },

  async onRetryHistory() {
    const house = this.data.houses[this.data.houseIndex];
    if (house && !this.data.historyLoading) await this.loadHistory(house.id);
  },

  async onMoreHistory() {
    const house = this.data.houses[this.data.houseIndex];
    if (house && !this.data.historyLoading && this.data.history.length < this.data.historyTotal) {
      await this.loadHistory(house.id, this.data.historyPage + 1);
    }
  },

  async onSwitchTab(e: WechatMiniprogram.BaseEvent) {
    const tab = String(e.currentTarget.dataset.tab);
    if (!['charge', 'history', 'today'].includes(tab) || tab === this.data.activeTab || this.data.submitting) return;
    // 离开收费面板前完成失焦保存，失败留在原处并保留输入。
    if (this.data.activeTab === 'charge' && !(await this.saveContact())) return;
    ++this.todayRequest;
    ++this.todaySummaryRequest;
    this.setData({ activeTab: tab as 'charge' | 'history' | 'today', todayDetailsExpanded: false, todayRows: [], todayPage: 0, todayLoading: false, todaySummaryLoading: false, todayError: '' });
    if (tab === 'today') await this.loadTodaySummary();
    const house = this.data.houses[this.data.houseIndex];
    if (tab === 'history' && house) await this.loadHistory(house.id);
  },

  todaySummaryRequest: 0,
  async loadTodaySummary(): Promise<void> {
    if (!this.data.canSeeCashier) return;
    const requestId = ++this.todaySummaryRequest;
    const day = formatBeijingDateTime(new Date(), 'YYYY-MM-DD');
    this.setData({ todaySummaryLoading: true, todaySummaryError: '', todayLoaded: false, todayDate: day });
    try {
      const result = await apartmentCashier.todaySummary();
      if (requestId !== this.todaySummaryRequest) return;
      if (day !== formatBeijingDateTime(new Date(), 'YYYY-MM-DD')) return this.loadTodaySummary();
      this.setData({ todaySummaryLoading: false, todayLoaded: true, todayTotal: result.total, todayAmountText: money(result.totalCents) });
    } catch (e: any) {
      if (requestId !== this.todaySummaryRequest) return;
      this.setData({ todaySummaryLoading: false, todaySummaryError: e?.message || '今日汇总读取失败，请重试' });
    }
  },

  async onToggleTodayDetails() {
    if (this.data.activeTab !== 'today' || !this.data.canSeeCashier || this.data.todaySummaryLoading) return;
    const expanded = !this.data.todayDetailsExpanded;
    ++this.todayRequest;
    this.setData({ todayDetailsExpanded: expanded, todayRows: [], todayPage: 0, todayLoading: false, todayError: '' });
    if (expanded) await this.loadToday();
  },

  todayRequest: 0,
  async loadToday(page = 1): Promise<void> {
    if (!this.data.canSeeCashier || !this.data.todayDetailsExpanded || this.data.activeTab !== 'today') return;
    const day = formatBeijingDateTime(new Date(), 'YYYY-MM-DD');
    const changedDay = !!this.data.todayDate && this.data.todayDate !== day;
    if (changedDay) page = 1;
    const requestId = ++this.todayRequest;
    this.setData({ todayLoading: true, todayError: '', todayDate: day, ...(changedDay ? { todayLoaded: false, todayRows: [], todayTotal: 0, todayPage: 0 } : {}) });
    try {
      const data = await apartmentCashier.today(page);
      if (requestId !== this.todayRequest) return;
      if (day !== formatBeijingDateTime(new Date(), 'YYYY-MM-DD') || (page > 1 && data.total !== this.data.todayTotal)) return this.loadToday();
      const records = [...(page > 1 ? this.data.todayRows : []), ...(data.rows || []).map((row) => ({
        ...recordView(row), key: `${row.houseId}:${row.receiptNo}`,
        placeText: dedupeAddressText([row.communityName, row.lane && /^\d+$/.test(row.lane) ? `${row.lane}弄` : row.lane, placeLabel(row.buildingNo, row.roomNo)].filter(Boolean).join(' ')),
      }))];
      this.setData({
        todayLoading: false, todayLoaded: true, todayPage: page, todayDate: day, todayTotal: data.total,
        // 汇总是后端按北京时间及完整权限范围计算的净额，不能累加第一页替代。
        todayAmountText: money(data.totalCents),
        todayRows: records.filter((row, index) => records.findIndex((item) => item.key === row.key) === index),
      });
    } catch (e: any) {
      if (requestId !== this.todayRequest) return;
      this.setData({ todayLoading: false, todayError: e?.message || '今日收费读取失败，请重试' });
    }
  },

  async onRefreshToday() {
    if (this.data.activeTab !== 'today' || this.data.todaySummaryLoading) return;
    ++this.todayRequest;
    this.setData({ todayRows: [], todayPage: 0, todayLoading: false, todayError: '' });
    await this.loadTodaySummary();
    if (this.data.activeTab === 'today' && this.data.todayDetailsExpanded) await this.loadToday();
  },
  async onMoreToday() {
    if (this.data.todayDetailsExpanded && !this.data.todaySummaryLoading && !this.data.todayLoading && this.data.todayRows.length < this.data.todayTotal) await this.loadToday(this.data.todayPage + 1);
  },

  // ---------------- 费用明细 ----------------

  onToggleFee(e: WechatMiniprogram.BaseEvent) {
    if(this.data.submitting)return;
    if(this.data.ratesLoading || this.rateQuote===undefined){this.setData({ratesError:this.data.ratesError || '收费标准尚未读到，请等待或重试'});return;}
    const code = String(e.currentTarget.dataset.code);
    const exists = this.data.rows.some((row) => row.feeCode === code);
    if (exists) {
      this.replaceRows(this.data.rows.filter((row) => row.feeCode !== code));
      return;
    }
    const def = APARTMENT_FEE_TYPES.find((item) => item.code === code);
    if (!def) return;
    if(!Object.prototype.hasOwnProperty.call(this.rates,code)){
      this.setData({ratesError:`${def.name}未配置收费标准，请在网页「公寓收费标准」配置并套用当前房间`});return;
    }
    this.ratesDraftInvalidated=false;
    this.setData({ratesError:''});
    const unitPriceCents = this.rates[code];
    const meta=this.rateMeta[code];
    const area=meta?.calculation==='area';
    this.replaceRows([
      ...this.data.rows,
      {
        feeCode: def.code,
        feeName: def.name,
        unit: area?(meta.cycle==='month'?'月':'次'):(meta?.unit || def.unit),
        priceHint: area?'本房金额（按面积已计算，不再乘面积）':'标准单价（元）',
        quantity: 1,
        quantityText: '1',
        unitPriceYuan: (unitPriceCents / 100).toFixed(2),
        amountYuan: (unitPriceCents / 100).toFixed(2),
        amountCents: unitPriceCents,
      },
    ]);
  },

  onRemoveFee(e: WechatMiniprogram.BaseEvent) {
    const code = String(e.currentTarget.dataset.code);
    this.replaceRows(this.data.rows.filter((row) => row.feeCode !== code));
  },

  /**
   * 单价只读且仅来自Web配置；数量改了重算金额，手填实收金额反推数量。
   */
  onRowInput(e: WechatMiniprogram.Input | WechatMiniprogram.PickerChange) {
    if(this.data.submitting)return;
    const code = String(e.currentTarget.dataset.code);
    const field = String(e.currentTarget.dataset.field) as 'quantityText' | 'amountYuan' | 'vehiclePlate' | 'serviceFrom' | 'serviceTo';
    if(!['quantityText','amountYuan','vehiclePlate','serviceFrom','serviceTo'].includes(field))return;
    const text = String(e.detail.value);
    const rows = this.data.rows.map((row) => {
      if (row.feeCode !== code) return row;
      const next = { ...row, [field]: text } as FeeRow;
      if(['vehiclePlate','serviceFrom','serviceTo'].includes(field))return row.feeCode==='parking'?next:row;
      if (field === 'quantityText') next.quantity = numberOf(text);
      if (field === 'amountYuan') {
        next.amountCents = yuanToCents(text);
        const quantity = cashierQuantityFromAmount(next.amountCents, yuanToCents(next.unitPriceYuan));
        if (quantity !== null) {
          next.quantity = quantity;
          next.quantityText = String(quantity);
        }
      } else {
        next.amountCents = Math.round(next.quantity * yuanToCents(next.unitPriceYuan));
        next.amountYuan = next.amountCents ? (next.amountCents / 100).toFixed(2) : '';
      }
      return next;
    });
    this.replaceRows(rows);
  },

  replaceRows(rows: FeeRow[]) {
    const codes = rows.map((row) => row.feeCode);
    this.setData({
      rows,
      feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: codes.indexOf(item.code) >= 0 })),
    });
    this.recount(rows);
  },

  recount(rows: FeeRow[]) {
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    this.setData({ totalCents, totalText: formatFeeMoney(totalCents) });
  },

  // ---------------- 收款 ----------------

  onPickMethod(e: WechatMiniprogram.BaseEvent) {
    this.setData({ paymentMethod: String(e.currentTarget.dataset.value), submitError: '' });
  },

  onInputOwnerName(e: WechatMiniprogram.Input) {
    if (!this.data.canCharge || this.data.submitting) return;
    this.setData({ ownerName: String(e.detail.value), contactStatus: '离开输入框后自动保存' });
  },

  onInputOwnerPhone(e: WechatMiniprogram.Input) {
    if (!this.data.canCharge || this.data.submitting) return;
    this.setData({ ownerPhone: String(e.detail.value), contactStatus: '离开输入框后自动保存' });
  },

  contactSavePromise: undefined as Promise<boolean> | undefined,
  async onBlurContact() { return this.saveContact(); },
  async saveContact(): Promise<boolean> {
    if (this.contactSavePromise) {
      const ok = await this.contactSavePromise;
      return ok ? this.saveContact() : false;
    }
    const house = this.data.houses[this.data.houseIndex];
    if (!house || !this.data.canCharge) return true;
    const rawName = this.data.ownerName, rawPhone = this.data.ownerPhone;
    const ownerName = rawName.trim(), ownerPhone = rawPhone.trim();
    if (ownerName === (house.owner?.name || '').trim() && ownerPhone === (house.owner?.phone || '').trim()) return true;
    this.setData({ contactSaving: true, contactError: '', contactStatus: '正在自动保存…' });
    const work = (async () => {
      try {
        const result = await apartmentCashier.updateContact(house.id, { ownerId: house.owner?.id, ownerName, ownerPhone });
        const sameHouse = this.data.houses[this.data.houseIndex]?.id === house.id;
        this.setData({
          houses: this.data.houses.map(row => row.id === house.id ? { ...row, owner: result.owner } : row),
          ...(sameHouse ? {
            ownerName: this.data.ownerName === rawName ? ownerName : this.data.ownerName,
            ownerPhone: this.data.ownerPhone === rawPhone ? ownerPhone : this.data.ownerPhone,
            contactError: '', contactStatus: '已自动保存',
          } : {}),
        });
        return true;
      } catch (e: any) {
        if (this.data.houses[this.data.houseIndex]?.id === house.id) this.setData({ contactError: e?.message || '保存失败，已保留输入，请重试', contactStatus: '' });
        return false;
      } finally {
        this.setData({ contactSaving: false });
      }
    })();
    this.contactSavePromise = work;
    const ok = await work;
    this.contactSavePromise = undefined;
    // 输入可能在前次请求期间变化；串行补存，禁止旧响应覆盖新输入。
    return ok ? this.saveContact() : false;
  },

  onInputRemark(e: WechatMiniprogram.Input) {
    this.setData({ remark: String(e.detail.value) });
  },

  async onSubmit() {
    if (!this.data.canCharge || this.data.submitting || this.data.activeTab !== 'charge') return;
    const house = this.data.houses[this.data.houseIndex];
    if (!house) return this.setData({ submitError: '先选房间' });
    if(this.rateQuote===undefined) return this.setData({submitError:'收费标准尚未读到，请重新选择房号核对单价后提交'});
    if (!this.data.rows.length) return this.setData({ submitError: '先添加收费项目' });
    if (this.data.rows.some((row) => row.amountCents <= 0)) {
      return this.setData({ submitError: '每一项都要填出金额，0 元的项先删掉' });
    }
    for(const row of this.data.rows){
      if(row.feeCode==='parking' && (!row.vehiclePlate?.trim() || !row.serviceFrom || !row.serviceTo))return this.setData({submitError:'停车费请填写车牌号、开始日期和结束日期'});
      const dateError=cashierServicePeriodError(row.serviceFrom,row.serviceTo);
      if(dateError)return this.setData({submitError:dateError});
    }
    if (!this.data.paymentMethod) return this.setData({ submitError: '选一个收款方式' });

    this.setData({ submitting: true, submitError: '' });
    if (!(await this.saveContact())) { this.setData({ submitting: false, submitError: '住户资料未保存，请先重试保存' }); return; }
    let confirm: WechatMiniprogram.ShowModalSuccessCallbackResult;
    try {
      confirm = await wx.showModal({
      title: '确认收款',
      content: `${this.data.placeText} ${this.data.ownerName || ''}\n${this.data.totalText}（${
        FEE_PAYMENT_METHOD_LABELS[this.data.paymentMethod]
      }）`,
      confirmText: '收款',
      });
    } catch {
      this.setData({ submitting: false, submitError: '确认窗口未能打开，请重试' });
      return;
    }
    if (!confirm.confirm) { this.setData({ submitting: false }); return; }

    this.setData({ submitting: true, submitError: '' });
    try {
      const result = await apartmentCashier.charge({
        houseId: house.id,
        rateQuote: this.rateQuote,
        ownerId: house.owner?.id,
        ownerName: this.data.ownerName,
        ownerPhone: this.data.ownerPhone,
        paymentMethod: this.data.paymentMethod,
        remark: this.data.remark,
        items: this.data.rows.map((row) => ({
          feeCode: row.feeCode,
          quantity: row.quantity,
          unit: row.unit,
          unitPriceCents: yuanToCents(row.unitPriceYuan),
          amountCents: row.amountCents,
          ...(row.feeCode==='parking'?{vehiclePlate:row.vehiclePlate?.trim(),serviceFrom:row.serviceFrom,serviceTo:row.serviceTo}:{}),
        })),
      });
      this.setData({
        submitting: false,
        receiptOpen: true,
        receiptNo: result.receiptNo,
        receiptAmountText: this.data.totalText,
        receiptItems: this.data.rows.map((row) => ({
          feeName: row.feeName,
          qtyText: row.quantity ? `×${row.quantity}${row.unit}` : '',
          amountText: money(row.amountCents),
          ...(row.feeCode==='parking'?{vehiclePlate:row.vehiclePlate?.trim(),serviceFrom:row.serviceFrom,serviceTo:row.serviceTo}:{}),
        })),
        rows: [],
        feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: false })),
        paymentMethod: '',
        remark: '',
        totalCents: 0,
        totalText: formatFeeMoney(0),
      });
      void this.offerPrint(result.receiptNo, false);
      // 隐藏面板不预取明细；切到对应Tab时再读最新结果。
      this.setData({ history: [], historyPage: 0, historyTotal: 0, todayLoaded: false, todayRows: [], todayPage: 0 });
    } catch (e: any) {
      // 失败保留输入：这一单是现场对着住户填的，清掉等于让人从头来一遍
      this.setData({ submitting: false, submitError: e?.message || '收款失败，刚填的内容已保留，可以直接重试' });
    }
  },

  async refreshPrinters() {
    try {
      const printers = await apartmentCashier.receiptPrinters();
      this.setData({ printAvailable: printers.length > 0, printListError: '' });
      return printers;
    } catch { this.setData({ printAvailable: false, printListError: '暂时无法获取打印机' }); return null; }
  },
  onRetryPrinters() { void this.refreshPrinters(); },
  onRetryReceiptPrint() { if (this.data.receiptNo) void this.offerPrint(this.data.receiptNo, false); },
  recordRequest: 0,
  onOpenRecord(e: WechatMiniprogram.TouchEvent) {
    const receiptNo = e.currentTarget.dataset.receipt;
    if (receiptNo) return this.loadRecord(receiptNo);
  },
  async loadRecord(receiptNo: string) {
    const request = ++this.recordRequest;
    this.setData({recordNo: receiptNo, recordError: '', recordDetail: null});
    try {
      const receipt = await apartmentCashier.receipt(receiptNo);
      if (request !== this.recordRequest) return;
      if (receipt.receiptNo !== receiptNo) throw new Error('小票号不一致，请重新读取');
      this.setData({recordDetail: detailView(receipt)});
    } catch (error: any) {
      if (request === this.recordRequest) this.setData({recordError: error?.message || '收费明细读取失败'});
    }
  },
  onCloseRecord() {
    ++this.recordRequest;
    this.setData({recordNo:'', recordDetail:null, recordError:''});
  },
  onPrintRow(e: WechatMiniprogram.TouchEvent) {
    const receipt = e.currentTarget.dataset.receipt;
    if (receipt) return this.offerPrint(receipt, true);
  },
  async offerPrint(receiptNo: string, reprint: boolean) {
    if (this.data.printBusy) return;
    this.setData({ printBusy: true });
    try {
      const allowed = await this.refreshPrinters();
      if (!allowed) {
        if(reprint) await wx.showModal({title:'打印机列表读取失败',content:'请检查网络后重试。',showCancel:false});
        return;
      }
      if (!allowed.length) {
        if (reprint) await wx.showModal({title:'未获打印授权',content:'请管理员在「员工与权限」中选择你的账号，打开「打印服务」勾选打印机。',showCancel:false});
        return;
      }
      const answer = await wx.showModal({ title: reprint?'补打这张小票？':'收款成功，打印小票？', content:'小票号 '+receiptNo,confirmText:'选打印机',cancelText:'取消' });
      if (!answer.confirm) return;
      const printers = allowed.filter(p=>p.online);
      if (!printers.length) { await wx.showModal({title:'打印机离线',content:'请检查打印电脑和助手，可稍后从收费记录补打。',showCancel:false}); return; }
      let index=0;
      for (;;) {
        const group=printers.slice(index,index+5), names=group.map(p=>p.name);
        const more=printers.length>5;
        if(more) names.push(index+5<printers.length?'下一组打印机':'返回第一组');
        const choice=await wx.showActionSheet({itemList:names});
        if(choice.tapIndex===group.length){index=index+5<printers.length?index+5:0;continue;}
        const requestId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
        const job=await apartmentCashier.queueReceipt(group[choice.tapIndex].id,receiptNo,reprint,requestId);
        let state=job.state;
        for(let i=0;i<6 && (state==='waiting'||state==='claimed');i++) {
          await new Promise(resolve=>setTimeout(resolve,1300));
          state=(await apartmentCashier.receiptPrintStatus(job.id)).state;
        }
        const message=state==='spooled'?'已送入打印队列，请核对出纸':state==='cancelled'||state==='expired'?'任务已取消或过期，请核对后补打':'打印结果待确认，请先核对现场出纸';
        await wx.showModal({title:'小票打印',content:message,showCancel:false});
        return;
      }
    } catch(e:any) {
      if(!String(e?.errMsg||'').includes('cancel')) await wx.showModal({title:'小票打印',content:e?.message||'未确认打印结果，请检查打印机。',showCancel:false});
    } finally { this.setData({printBusy:false}); }
  },
  onCloseReceipt() {
    this.setData({ receiptOpen: false });
  },

  noop() {},
});

interface CashierRecordView {
  receiptNo: string;
  timeText: string;
  itemsText: string;
  amountText: string;
  methodText: string;
  refunded: boolean;
  statusText: string;
}

function recordView(row: apartmentCashier.CashierHistoryRow): CashierRecordView {
  return {
    receiptNo: row.receiptNo,
    timeText: formatPaidAt(row.paidAt),
    itemsText: (row.items || []).map((item) => {
      const quantity = item.quantity;
      return `${item.feeName}${typeof quantity === 'number' && Number.isFinite(quantity) ? ` ×${quantity}${item.unit || ''}` : '（数量未记录）'}`;
    }).join('、'),
    amountText: money(row.amountCents),
    methodText: FEE_PAYMENT_METHOD_LABELS[row.paymentMethod] || row.paymentMethod || '收款方式未记录',
    refunded: row.status === 'refunded' && row.amountCents >= 0,
    statusText: row.amountCents < 0 ? '红冲退款' : row.status === 'refunded' ? '已红冲' : '',
  };
}

/** 负数金额按中文习惯写成 -¥1,500.00 */
function money(cents: number): string {
  return cents < 0 ? `-${formatFeeMoney(-cents)}` : formatFeeMoney(cents);
}

/** 历史缴费只要「几月几号几点」，年份同年就省掉 */
function formatPaidAt(iso: string): string {
  const year = formatBeijingDateTime(iso, 'YYYY');
  const sameYear = year === formatBeijingDateTime(new Date(), 'YYYY');
  return formatBeijingDateTime(iso, sameYear ? 'M/D HH:mm' : 'YYYY/M/D HH:mm');
}

function detailView(r: apartmentCashier.CashierReceiptDetail) {
  return {
    receiptNo:r.receiptNo, amount:money(r.amountCents), status:r.amountCents<0?'红冲退款':r.status==='refunded'?'已红冲':'',
    address:r.fullAddress || [r.communityName,r.lane,r.buildingNo,r.roomNo].filter(Boolean).join(' '),
    time:r.paidAt?formatBeijingDateTime(r.paidAt,'YYYY-MM-DD HH:mm'):'',
    method:r.paymentMethod?(FEE_PAYMENT_METHOD_LABELS[r.paymentMethod] || r.paymentMethod):'',
    cashier:r.cashier, remark:r.remark,
    items:r.items.map(i=>({id:i.id,feeName:i.feeName,amount:money(i.amountCents),
      pricing:[i.unitPriceCents!=null?money(i.unitPriceCents):'',i.quantity!=null?'× '+i.quantity+(i.unit||''):''].filter(Boolean).join(' '),
      vehicle:i.vehiclePlate,period:[i.serviceFrom,i.serviceTo].filter(Boolean).join(' 至 ')})),
  };
}
