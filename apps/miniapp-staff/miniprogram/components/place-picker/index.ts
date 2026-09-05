import {
  formatBuildingFull,
  formatBuildingLabel,
  formatFullAddress,
  type AddressBuilding,
  type AddressCommunity,
  type AddressHouse,
} from '@pms/shared-types';
import { suggestAddresses, type AddressSuggestion } from '../../utils/address-picker';

/**
 * 报修位置选择器 —— 和管理后台「办公室录入报修」是同一套选法，只是排成手机的样子。
 *
 * 后台用的是 Cascader（changeOnSelect），三级里任何一级都能停下；
 * 手机上放不下级联面板，改成「逐层钻取 + 面包屑」，每层顶部给一个
 * 「就报这一级」的按钮，等价于后台停在该级：
 *   停在小区  = 小区公共区域（大门、道闸、路灯…）
 *   停在楼栋  = 本楼公共区域（楼道、电梯、信箱…）
 *   选到房号  = 具体某户
 *   「不填房号」= 后台那个「不肯说」，只落到楼栋
 *
 * 搜索框与后台共用 scoreAddressPath，输入「228/4/201」的联想结果两端一致。
 */

export interface PickedPlace {
  communityId: number;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  houseId: number | null;
  roomNo: string;
  /** 枫桦景苑二期 228弄4号 201室 —— 直接落到工单的地址快照 */
  fullText: string;
  /** 停在小区/楼栋这一级，即公共区域单 */
  isPublicArea: boolean;
}

type Level = 'community' | 'building' | 'house';

interface Row {
  key: string;
  label: string;
  /** 右侧灰字：户数 / 业主一般不显示 */
  note: string;
}


/**
 * 地址簿与当前钻取位置存在组件外的 WeakMap 里，不进 data ——
 * 一个小区上千条房号，进 data 就是一次巨大的 setData，面板一打开明显卡顿。
 * （小程序 Component 的类型定义不接受自定义根字段，所以不挂 this 上。）
 */
interface PickerStore {
  book: AddressCommunity[];
  community: AddressCommunity | null;
  building: AddressBuilding | null;
}

const STORE = new WeakMap<object, PickerStore>();

function store(ctx: object): PickerStore {
  let hit = STORE.get(ctx);
  if (!hit) {
    hit = { book: [], community: null, building: null };
    STORE.set(ctx, hit);
  }
  return hit;
}

// 泛型放宽到 IAnyObject：地址簿这类大对象要挂在实例上（不进 data），
// 严格泛型下 Component 的 Options 不接受自定义根字段。
Component<
  WechatMiniprogram.IAnyObject,
  WechatMiniprogram.IAnyObject,
  WechatMiniprogram.IAnyObject,
  WechatMiniprogram.IAnyObject
>({
  properties: {
    /** 已选中的展示文案，由页面回传，组件只负责选 */
    valueText: { type: String, value: '' },
    loading: { type: Boolean, value: false },
    /** 报修三步表单使用紧凑外观，标签和辅助说明由页面统一排版 */
    compact: { type: Boolean, value: false },
  },

  data: {
    open: false,
    level: 'community' as Level,
    keyword: '',
    suggestions: [] as AddressSuggestion[],
    rows: [] as Row[],
    /** 面包屑：已选到的小区 / 楼栋 */
    communityName: '',
    buildingText: '',
    /** 「就报这一级」按钮的文案，跟着当前层变 */
    stayLabel: '',
  },

  methods: {
    /**
     * 空实现，专门给遮罩和面板的 catchtouchmove 用：
     * 把滑动手势吞掉，别让它传到底下的页面（否则「列表没动、背景动了」）。
     * 面板里的 scroll-view 自己滚，不受这个影响。
     */
    onBlockMove() {},

    /**
     * 地址簿由页面用 selectComponent 直接递进来，不走 properties ——
     * 一个小区上千条房号，进 properties 就是一次巨大的 setData，
     * 面板一打开明显卡顿。这里只存引用，渲染时按当前层切片。
     */
    setBook(book: AddressCommunity[]) {
      store(this).book = book || [];
      this.rebuild();
    },

    // ---------------- 数据 ----------------

    rebuild() {
      store(this).community = null;
      store(this).building = null;
      this.setData({
        level: 'community',
        communityName: '',
        buildingText: '',
        keyword: '',
        suggestions: [],
      });
      this.renderRows();
    },

    renderRows() {
      const level = this.data.level;
      let rows: Row[] = [];
      let stayLabel = '';

      if (level === 'community') {
        rows = store(this).book
          .filter((item: AddressCommunity) => !item.isGroup)
          .map((item: AddressCommunity) => ({
            key: `c${item.id}`,
            label: item.mainLane ? `${item.name}（${item.mainLane}弄）` : item.name,
            note: `${item.buildings.length} 栋`,
          }));
      } else if (level === 'building') {
        const community = store(this).community as AddressCommunity;
        rows = community.buildings.map((item: AddressBuilding) => ({
          key: `b${item.id}`,
          label: formatBuildingLabel(community, item),
          note: `${item.houses.length} 户`,
        }));
        stayLabel = `就报「${community.name}」的公共区域`;
      } else {
        const building = store(this).building as AddressBuilding;
        rows = building.houses.map((item: AddressHouse) => ({
          key: `h${item.id}`,
          label: item.shopName ? `${item.roomNo} · ${item.shopName}` : item.roomNo,
          note: '',
        }));
        stayLabel = `就报「${formatBuildingFull(building)}」的公共区域`;
      }

      this.setData({ rows, stayLabel });
    },

    // ---------------- 交互 ----------------

    onOpen() {
      this.setData({ open: true });
      // 页面要知道选择器开着没：系统返回（iOS 右滑）要先关它再退页，见 pages/repair-create
      this.triggerEvent('openchange', { open: true });
      this.rebuild();
    },

    onClose() {
      this.setData({ open: false });
      this.triggerEvent('openchange', { open: false });
    },

    onBack() {
      if (this.data.level === 'house') {
        store(this).building = null;
        this.setData({ level: 'building', buildingText: '' });
      } else if (this.data.level === 'building') {
        store(this).community = null;
        this.setData({ level: 'community', communityName: '' });
      }
      this.renderRows();
    },

    onPickRow(e: WechatMiniprogram.BaseEvent) {
      const index = Number(e.currentTarget.dataset.index);
      const level = this.data.level;

      if (level === 'community') {
        const community = store(this).book.filter(
          (item) => !item.isGroup,
        )[index];
        if (!community) return;
        store(this).community = community;
        this.setData({ level: 'building', communityName: community.name });
        return this.renderRows();
      }

      if (level === 'building') {
        const building = (store(this).community as AddressCommunity).buildings[index];
        if (!building) return;
        store(this).building = building;
        this.setData({ level: 'house', buildingText: formatBuildingFull(building) });
        return this.renderRows();
      }

      const house = (store(this).building as AddressBuilding).houses[index];
      if (!house) return;
      this.commit(store(this).community, store(this).building, house);
    },

    /** 停在当前这一级 = 公共区域单 */
    onStayHere() {
      if (this.data.level === 'building') {
        return this.commit(store(this).community, null, null);
      }
      if (this.data.level === 'house') {
        return this.commit(store(this).community, store(this).building, null);
      }
    },

    /** 后台那个「不肯说」：只落到楼栋，不带房号 */
    onSkipRoom() {
      this.commit(store(this).community, store(this).building, null, { unknownRoom: true });
    },

    // ---------------- 搜索联想 ----------------

    onKeyword(e: WechatMiniprogram.Input) {
      const keyword = e.detail.value;
      this.setData({
        keyword,
        suggestions: suggestAddresses(store(this).book, keyword),
      });
    },

    onPickSuggestion(e: WechatMiniprogram.BaseEvent) {
      const picked: AddressSuggestion = this.data.suggestions[Number(e.currentTarget.dataset.index)];
      if (!picked) return;
      this.triggerEvent('picked', {
        communityId: picked.communityId,
        communityName: picked.communityName,
        buildingId: picked.buildingId,
        buildingText: picked.buildingText,
        houseId: picked.houseId,
        roomNo: picked.roomNo,
        fullText: formatFullAddress(
          picked.communityName,
          picked.buildingId
            ? { lane: picked.lane, buildingNo: picked.buildingNo, roadName: null }
            : undefined,
          picked.roomNo,
        ),
        // 联想只选到小区或楼栋，同样算公共区域
        isPublicArea: !picked.houseId,
      } as PickedPlace);
      this.setData({ open: false, keyword: '', suggestions: [] });
      this.triggerEvent('openchange', { open: false });
    },

    // ---------------- 提交 ----------------

    commit(
      community: AddressCommunity | null,
      building: AddressBuilding | null,
      house: AddressHouse | null,
      opts: { unknownRoom?: boolean } = {},
    ) {
      if (!community) return;
      const fullText = formatFullAddress(community.name, building ?? undefined, house?.roomNo);
      this.triggerEvent('picked', {
        communityId: community.id,
        communityName: community.name,
        buildingId: building?.id ?? null,
        buildingText: building ? formatBuildingFull(building) : '',
        houseId: house?.id ?? null,
        roomNo: house?.roomNo ?? '',
        fullText: opts.unknownRoom ? `${fullText}（未提供房号）` : fullText,
        // 不肯说房号仍是某一户的事，不算公共区域
        isPublicArea: !house && !opts.unknownRoom,
      } as PickedPlace);
      this.setData({ open: false, keyword: '', suggestions: [] });
      this.triggerEvent('openchange', { open: false });
    },
  },
});
