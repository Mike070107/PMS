/**
 * 公寓收费工作台（员工端）。
 *
 * 和网站后台「收费业务 → 公寓收费工作台」是同一套接口、同一份费用清单
 * （@pms/shared-types 的 APARTMENT_FEE_TYPES）和同一套地址写法（placeLabel），
 * 不是另做一个平行实现 —— 两端小票上的项目名、单位、地址必须一模一样。
 *
 * 手机上做了两处收敛：
 *   · 选址用原生 picker（小区 → 楼栋 → 房号），不做联想搜索；公寓楼栋房号本来就少；
 *   · 不做补打和红冲。小票是凭证，红冲要留原因、要对账，在电脑上办更稳妥；
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
    communityText: '',
    ownerName: '',
    ownerPhone: '',

    /** 可点的费用按钮 */
    feeTypes: APARTMENT_FEE_TYPES.map((item) => ({ ...item, active: false })),
    rows: [] as FeeRow[],
    totalText: formatFeeMoney(0),
    totalCents: 0,

    paymentMethods: PAYMENT_METHODS,
    paymentMethod: '',
    remark: '',
    submitting: false,
    submitError: '',

    /** 收完款弹出的小票 */
    receiptOpen: false,
    receiptNo: '',
    receiptItems: [] as Array<{ feeName: string; qtyText: string; amountText: string }>,
    receiptAmountText: '',

    historyLoading: false,
    history: [] as Array<{
      receiptNo: string;
      timeText: string;
      itemsText: string;
      amountText: string;
      methodText: string;
      refunded: boolean;
    }>,
  },

  onShow() {
    this.syncGuide();
    syncTabBar(this, 'cashier');
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
      const rows = await apartmentCashier.communities();
      // 他的数据范围只有一个小区时，那就是「他自己的小区」，直接选上。
      // 范围是多个（或全公司）时不替他猜，让他自己点。
      const scoped = session.me?.access?.communityIds || [];
      const mine = scoped.length ? rows.filter((item) => scoped.indexOf(item.id) >= 0) : rows;
      this.setData({
        communities: rows,
        communityNames: rows.map((item) => item.name),
        loading: false,
      });
      if (mine.length === 1) {
        await this.pickCommunity(rows.findIndex((item) => item.id === mine[0].id));
      }
    } catch (e: any) {
      this.setData({ loading: false, error: e?.message || '小区加载失败，下拉重试或稍后再进来' });
    }
  },

  // ---------------- 选址 ----------------

  onPickCommunity(e: WechatMiniprogram.PickerChange) {
    void this.pickCommunity(Number(e.detail.value));
  },

  async pickCommunity(index: number) {
    const community = this.data.communities[index];
    if (!community) return;
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
    const house = this.data.houses[index];
    if (!house) return;
    this.setData({
      houseIndex: index,
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
    await Promise.all([this.loadRates(house.id), this.loadHistory(house.id)]);
  },

  /** 换楼栋 / 换小区时，房间和这一单全部清掉 —— 不能把上一间的费用带过去 */
  clearedHouse() {
    return {
      houses: [] as CashierHouse[],
      houseNames: [] as string[],
      houseIndex: -1,
      placeText: '',
      ownerName: '',
      ownerPhone: '',
      rows: [] as FeeRow[],
      feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: false })),
      paymentMethod: '',
      remark: '',
      submitError: '',
      totalCents: 0,
      totalText: formatFeeMoney(0),
      history: [],
    };
  },

  get currentHouse(): CashierHouse | undefined {
    return this.data.houses[this.data.houseIndex];
  },

  // ---------------- 单价与历史 ----------------

  rates: {} as Record<string, number>,
  rateQuote: undefined as string | null | undefined,
  ratesRequest: 0,

  async loadRates(houseId: number) {
    const requestId=++this.ratesRequest;
    this.rates = {};
    this.rateQuote=undefined;
    try {
      const data = await apartmentCashier.standards(houseId);
      if(requestId!==this.ratesRequest)return;
      this.rateQuote=data.rateQuote;
      const map: Record<string, number> = {};
      for (const item of data.standards || []) {
        if (item.status === 'active') map[item.feeCode] = item.amountCents;
      }
      this.rates = map;
    } catch {
      // 拿不到标准不算错：单价留空让收费员自己填，不要把人卡在这
    }
  },

  async loadHistory(houseId: number) {
    this.setData({ historyLoading: true });
    try {
      const data = await apartmentCashier.history(houseId, 1);
      this.setData({
        historyLoading: false,
        history: (data.rows || []).map((row) => ({
          receiptNo: row.receiptNo,
          timeText: formatPaidAt(row.paidAt),
          itemsText: (row.items || []).map((item) => item.feeName).join('、'),
          amountText: money(row.amountCents),
          methodText: FEE_PAYMENT_METHOD_LABELS[row.paymentMethod] || row.paymentMethod,
          refunded: row.status === 'refunded',
        })),
      });
    } catch (e: any) {
      this.setData({ historyLoading: false, history: [] });
      wx.showToast({ icon: 'none', title: e?.message || '历史缴费加载失败' });
    }
  },

  // ---------------- 费用明细 ----------------

  onToggleFee(e: WechatMiniprogram.BaseEvent) {
    const code = String(e.currentTarget.dataset.code);
    const exists = this.data.rows.some((row) => row.feeCode === code);
    if (exists) {
      this.replaceRows(this.data.rows.filter((row) => row.feeCode !== code));
      return;
    }
    const def = APARTMENT_FEE_TYPES.find((item) => item.code === code);
    if (!def) return;
    const unitPriceCents = this.rates[code] || 0;
    this.replaceRows([
      ...this.data.rows,
      {
        feeCode: def.code,
        feeName: def.name,
        unit: def.unit,
        quantity: 1,
        quantityText: '1',
        unitPriceYuan: unitPriceCents ? (unitPriceCents / 100).toFixed(2) : '',
        amountYuan: unitPriceCents ? (unitPriceCents / 100).toFixed(2) : '',
        amountCents: unitPriceCents,
      },
    ]);
  },

  onRemoveFee(e: WechatMiniprogram.BaseEvent) {
    const code = String(e.currentTarget.dataset.code);
    this.replaceRows(this.data.rows.filter((row) => row.feeCode !== code));
  },

  /**
   * 数量、单价改了重算金额；手填实收金额反推三位小数的数量，金额保持手填值。
   */
  onRowInput(e: WechatMiniprogram.Input) {
    const code = String(e.currentTarget.dataset.code);
    const field = String(e.currentTarget.dataset.field) as 'quantityText' | 'unitPriceYuan' | 'amountYuan';
    const text = String(e.detail.value);
    const rows = this.data.rows.map((row) => {
      if (row.feeCode !== code) return row;
      const next = { ...row, [field]: text } as FeeRow;
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
    this.setData({ ownerName: String(e.detail.value) });
  },

  onInputOwnerPhone(e: WechatMiniprogram.Input) {
    this.setData({ ownerPhone: String(e.detail.value) });
  },

  onInputRemark(e: WechatMiniprogram.Input) {
    this.setData({ remark: String(e.detail.value) });
  },

  async onSubmit() {
    if (!this.data.canCharge || this.data.submitting) return;
    const house = this.data.houses[this.data.houseIndex];
    if (!house) return this.setData({ submitError: '先选房间' });
    if(this.rateQuote===undefined) return this.setData({submitError:'收费标准尚未读到，请重新选择房号核对单价后提交'});
    if (!this.data.rows.length) return this.setData({ submitError: '先添加收费项目' });
    if (this.data.rows.some((row) => row.amountCents <= 0)) {
      return this.setData({ submitError: '每一项都要填出金额，0 元的项先删掉' });
    }
    if (!this.data.paymentMethod) return this.setData({ submitError: '选一个收款方式' });

    this.setData({ submitting: true, submitError: '' });
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
        })),
        rows: [],
        feeTypes: this.data.feeTypes.map((item) => ({ ...item, active: false })),
        paymentMethod: '',
        remark: '',
        totalCents: 0,
        totalText: formatFeeMoney(0),
      });
      await this.loadHistory(house.id);
    } catch (e: any) {
      // 失败保留输入：这一单是现场对着住户填的，清掉等于让人从头来一遍
      this.setData({ submitting: false, submitError: e?.message || '收款失败，刚填的内容已保留，可以直接重试' });
    }
  },

  onCloseReceipt() {
    this.setData({ receiptOpen: false });
  },

  noop() {},
});

/** 负数金额按中文习惯写成 -¥1,500.00 */
function money(cents: number): string {
  return cents < 0 ? `-${formatFeeMoney(-cents)}` : formatFeeMoney(cents);
}

/** 历史缴费只要「几月几号几点」，年份同年就省掉 */
function formatPaidAt(iso: string): string {
  const date = new Date(String(iso).replace(/-/g, '/').replace(/\..*$/, ''));
  if (Number.isNaN(date.getTime())) return String(iso || '');
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const head = sameYear ? '' : `${date.getFullYear()}/`;
  return `${head}${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
