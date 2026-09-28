import {
  formatBuildingFull,
  formatBuildingLabel,
  formatFullAddress,
  DEFAULT_LOCATION_SUGGESTIONS,
  type AddressBuilding,
  type AddressCommunity,
  type AddressCommunitySpot,
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
  /** 直接选择的公区点位；页面会回填到可编辑的“具体位置”。 */
  spotName?: string;
}

type Level = 'community' | 'building' | 'house';

interface Row {
  key: string;
  label: string;
  /** 右侧灰字：户数 / 业主一般不显示 */
  note: string;
}

interface SpotRow {
  key: string;
  label: string;
  note: string;
  communityId: number;
  buildingId: number | null;
  buildingText: string;
  name: string;
}

type PlaceSuggestion = AddressSuggestion | (SpotRow & {
  kind: 'spot';
  text: string;
  communityName: string;
});


/**
 * 地址簿与当前钻取位置存在组件外的 WeakMap 里，不进 data ——
 * 一个小区上千条房号，进 data 就是一次巨大的 setData，面板一打开明显卡顿。
 * （小程序 Component 的类型定义不接受自定义根字段，所以不挂 this 上。）
 */
interface PickerStore {
  book: AddressCommunity[];
  spots: AddressCommunitySpot[];
  community: AddressCommunity | null;
  building: AddressBuilding | null;
}

const STORE = new WeakMap<object, PickerStore>();

function store(ctx: object): PickerStore {
  let hit = STORE.get(ctx);
  if (!hit) {
    hit = { book: [], spots: [], community: null, building: null };
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
    suggestions: [] as PlaceSuggestion[],
    rows: [] as Row[],
    spotRows: [] as SpotRow[],
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
    setBook(book: AddressCommunity[], spots: AddressCommunitySpot[] = []) {
      store(this).book = book || [];
      store(this).spots = (spots || []).filter((item) => item.enabled !== false);
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
      let spotRows: SpotRow[] = [];
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
        spotRows = this.spotRowsFor(community.id, null, true);
      } else {
        const building = store(this).building as AddressBuilding;
        rows = building.houses.map((item: AddressHouse) => ({
          key: `h${item.id}`,
          label: item.shopName ? `${item.roomNo} · ${item.shopName}` : item.roomNo,
          note: '',
        }));
        stayLabel = `就报「${formatBuildingFull(building)}」的公共区域`;
        spotRows = this.spotRowsFor(
          (store(this).community as AddressCommunity).id,
          building.id,
          false,
        );
      }

      this.setData({ rows, spotRows, stayLabel });
    },

    /** 已登记点位优先；小区层再补常用公区，没建档也能选“监控室/门卫室”。 */
    spotRowsFor(communityId: number, buildingId: number | null, includeDefaults: boolean): SpotRow[] {
      const real = store(this).spots
        .filter((item) => item.communityId === communityId && item.buildingId === buildingId)
        .map((item) => ({
          key: `s${item.id}`,
          label: item.name,
          note: item.buildingText || '公区点位',
          communityId,
          buildingId: item.buildingId,
          buildingText: item.buildingText || '',
          name: item.name,
        }));
      if (!includeDefaults) return real;
      const existing = new Set(real.map((item) => item.name));
      return real.concat(
        DEFAULT_LOCATION_SUGGESTIONS
          .filter((name) => !existing.has(name))
          .map((name) => ({
            key: `common-${communityId}-${name}`,
            label: name,
            note: '常用公共区域',
            communityId,
            buildingId: null,
            buildingText: '',
            name,
          })),
      );
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
      const normalized = keyword.replace(/[\s/，,、]/g, '');
      const selectedCommunity = store(this).community;
      const communities = store(this).book.filter((item) =>
        !item.isGroup && (!selectedCommunity || item.id === selectedCommunity.id),
      );
      const spotNames = new Set([
        ...store(this).spots.map((item) => item.name),
        ...DEFAULT_LOCATION_SUGGESTIONS,
      ]);
      const mentionedSpot = [...spotNames].find((name) => normalized.includes(name));
      const realByCommunity = new Map<number, AddressCommunitySpot[]>();
      store(this).spots.forEach((item) => {
        realByCommunity.set(item.communityId, [...(realByCommunity.get(item.communityId) || []), item]);
      });
      const spotSuggestions: PlaceSuggestion[] = [];
      if (normalized && mentionedSpot) {
        for (const community of communities) {
          const communityKey = community.name.replace(/[\s/，,、]/g, '');
          if (normalized.length > mentionedSpot.length && !normalized.includes(communityKey)) continue;
          const real = (realByCommunity.get(community.id) || []).filter(
            (item) => normalized.includes(item.name) || item.name.includes(normalized),
          );
          const rows = real.length
            ? real.map((item) => ({
                key: `s${item.id}`,
                label: item.name,
                note: item.buildingText || '公区点位',
                communityId: community.id,
                buildingId: item.buildingId,
                buildingText: item.buildingText || '',
                name: item.name,
              }))
            : (this.spotRowsFor(community.id, null, true) as SpotRow[])
                .filter((item: SpotRow) => item.name === mentionedSpot);
          (rows as SpotRow[]).forEach((row: SpotRow) => spotSuggestions.push({
            ...row,
            kind: 'spot',
            communityName: community.name,
            text: [community.name, row.buildingText, row.name].filter(Boolean).join(' / '),
          }));
        }
      }
      this.setData({
        keyword,
        suggestions: [...spotSuggestions, ...suggestAddresses(store(this).book, keyword)]
          .slice(0, 8) as PlaceSuggestion[],
      });
    },

    onPickSuggestion(e: WechatMiniprogram.BaseEvent) {
      const picked: PlaceSuggestion = this.data.suggestions[Number(e.currentTarget.dataset.index)];
      if (!picked) return;
      if ((picked as { kind?: string }).kind === 'spot') {
        return this.commitSpot(picked as SpotRow);
      }
      const addressPicked = picked as AddressSuggestion;
      this.triggerEvent('picked', {
        communityId: addressPicked.communityId,
        communityName: addressPicked.communityName,
        buildingId: addressPicked.buildingId,
        buildingText: addressPicked.buildingText,
        houseId: addressPicked.houseId,
        roomNo: addressPicked.roomNo,
        fullText: formatFullAddress(
          addressPicked.communityName,
          addressPicked.buildingId
            ? { lane: addressPicked.lane, buildingNo: addressPicked.buildingNo, roadName: null }
            : undefined,
          addressPicked.roomNo,
        ),
        // 联想只选到小区或楼栋，同样算公共区域
        isPublicArea: !addressPicked.houseId,
      } as PickedPlace);
      this.setData({ open: false, keyword: '', suggestions: [] });
      this.triggerEvent('openchange', { open: false });
    },

    onPickSpotRow(e: WechatMiniprogram.BaseEvent) {
      const picked: SpotRow = this.data.spotRows[Number(e.currentTarget.dataset.index)];
      if (picked) this.commitSpot(picked);
    },

    commitSpot(picked: SpotRow) {
      const community = store(this).book.find((item) => item.id === picked.communityId);
      if (!community) return;
      const building = picked.buildingId
        ? community.buildings.find((item) => item.id === picked.buildingId) || null
        : null;
      this.triggerEvent('picked', {
        communityId: community.id,
        communityName: community.name,
        buildingId: building?.id ?? null,
        buildingText: building ? formatBuildingFull(building) : picked.buildingText,
        houseId: null,
        roomNo: '',
        // 点位单独回填到“具体位置”，这里保持基础地址，避免提交时重复两遍点位名。
        fullText: formatFullAddress(community.name, building),
        isPublicArea: true,
        spotName: picked.name,
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
