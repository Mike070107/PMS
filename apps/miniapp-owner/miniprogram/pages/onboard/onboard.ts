import { address, auth, qr } from '@pms/api-client';
import { AuditStatus } from '@pms/shared-types';
import type { PublicCommunity } from '@pms/api-client/src/endpoints/address';
import { scanForToken } from '../../utils/scan';
import { ensureOwnerLogin } from '../../utils/session';

interface PageData {
  communityId: number | null;
  communityName: string;
  buildingId: number | null;
  placeText: string;
  /** 弄由所选小区（或扫码）决定，不让业主填 */
  lane: string;
  /** 「枫桦景苑一期的楼栋在 198 弄」这类说明 */
  laneHint: string;
  buildingNo: string;
  fromScan: boolean;
  roomNo: string;
  /** 业主姓名：物业要拿它跟房产登记信息核对，不填审核那边只能看到一条空记录 */
  realName: string;
  phone: string;
  phoneCode: string;
  submitting: boolean;
  errors: { place: string; building: string; room: string; name: string; phone: string };
  /** 选小区 */
  communityNames: string[];
  communityIndex: number;
  communityLoading: boolean;
  /** 小区列表没拉到时给出原因和重试，不能默默把选择器藏了 */
  communityError: string;
  /** 预填是哪来的：扫码 / 当前绑定 / 上次填的。必须让用户看得见 */
  prefillHint: string;
}

const PHONE_RE = /^1[3-9]\d{9}$/;

/** 上次填过但还没通过审核的内容，只存本机、只存自己填的 */
const DRAFT_KEY = 'pms.onboard.draft';

interface OnboardDraft {
  communityId: number;
  buildingNo: string;
  roomNo: string;
}

function readDraft(): OnboardDraft | null {
  try {
    const raw = wx.getStorageSync(DRAFT_KEY);
    return raw && raw.communityId ? (raw as OnboardDraft) : null;
  } catch {
    return null;
  }
}

function saveDraft(draft: OnboardDraft) {
  try {
    wx.setStorageSync(DRAFT_KEY, draft);
  } catch {
    // 存不下不影响主流程
  }
}

function clearDraft() {
  try {
    wx.removeStorageSync(DRAFT_KEY);
  } catch {
    // 忽略
  }
}

/** 「228弄3号」→「3」；商铺的「153号」→「153」 */
function parseBuildingNo(buildingText: string): string {
  const matched = /(?:.*弄)?\s*([^弄号\s]+)号/.exec(buildingText || '');
  return matched ? matched[1] : '';
}

/** 「枫桦景苑·一期（198弄）」——和后台房产页的 小区·分期 口径一致 */
function communityLabel(item: PublicCommunity): string {
  const base = item.groupName ? `${item.groupName}·${item.shortName}` : item.name;
  return item.mainLane ? `${base}（${item.mainLane}弄）` : base;
}

Page<PageData, WechatMiniprogram.IAnyObject>({
  data: {
    communityId: null,
    communityName: '',
    buildingId: null,
    placeText: '',
    lane: '',
    laneHint: '',
    buildingNo: '',
    fromScan: false,
    roomNo: '',
    realName: '',
    phone: '',
    phoneCode: '',
    submitting: false,
    errors: { place: '', building: '', room: '', name: '', phone: '' },
    communityNames: [],
    communityIndex: -1,
    communityLoading: false,
    communityError: '',
    prefillHint: '',
  },

  communities: [] as PublicCommunity[],

  onLoad(q: Record<string, string>) {
    // token：小程序内扫码带过来；scene：微信扫一扫小程序码直接落到本页
    const token = q.token || (q.scene ? decodeURIComponent(q.scene) : '');
    if (token) {
      this.resolveToken(token);
    } else {
      // 非扫码进来：按「当前绑定 → 上次填过 → 空」的顺序预填，并且标明来源。
      // 只用这个人自己确认过的东西，绝不拿别处的楼栋往上填。
      this.prefillWithoutScan();
    }
    this.loadCommunities();
  },

  /** 预填来源按优先级取第一个命中的；每种都会在界面上说清楚是哪来的 */
  async prefillWithoutScan() {
    try {
      const me = await auth.me().catch(() => null);
      const place = me?.place ?? null;

      // 审核通过后就以正式绑定为准，本机草稿留着只会跟绑定打架
      if (place?.auditStatus === AuditStatus.APPROVED) clearDraft();

      if (me?.name) this.setData({ realName: me.name });

      if (place?.communityId) {
        const buildingNo = parseBuildingNo(place.buildingText || '');
        this.setData({
          communityId: place.communityId,
          communityName: place.communityName || '',
          buildingId: place.buildingId ?? null,
          buildingNo,
          roomNo: place.roomNo || '',
          placeText: place.addressText || '',
          prefillHint: `你当前绑定的是 ${place.addressText || place.communityName}，换房请直接改`,
        });
        this.syncPickedCommunity();
        return;
      }

      const draft = readDraft();
      if (draft) {
        this.setData({
          communityId: draft.communityId,
          buildingNo: draft.buildingNo,
          roomNo: draft.roomNo,
          prefillHint: '这是你上次填的，不对请直接改',
        });
        this.syncPickedCommunity();
      }
    } catch {
      // 预填失败就是空表单，不影响手填
    }
  },

  /**
   * 没有码、或码找不到时，让业主自己选小区。
   * 本页可能就是启动页（扫码进来、或从首页直接进），要自己确保登录，
   * 否则 401 会让选择器一直是空的，页面看上去就只剩扫码。
   */
  async loadCommunities() {
    this.setData({ communityLoading: true, communityError: '' });
    try {
      if (!(await ensureOwnerLogin())) {
        throw new Error('请先登录后再选择小区');
      }
      this.communities = await address.communities();
      this.setData({
        communityNames: this.communities.map(communityLabel),
        communityError: this.communities.length ? '' : '还没有可选的小区，请扫码或联系物业',
      });
      this.syncPickedCommunity();
    } catch (e: any) {
      // 静默失败会让页面只剩扫码、用户以为只能扫码 —— 必须把原因摆出来并给重试
      this.setData({
        communityNames: [],
        communityError: e?.message || '小区列表加载失败',
      });
    } finally {
      this.setData({ communityLoading: false });
    }
  },

  onRetryCommunities() {
    this.loadCommunities();
  },

  /** 扫码先到、小区列表后到时，把下拉的选中态补上 */
  syncPickedCommunity() {
    const { communityId } = this.data;
    if (!communityId) return;
    const index = this.communities.findIndex((item: PublicCommunity) => item.id === communityId);
    if (index >= 0) this.applyCommunity(index, { keepBuilding: true });
  },

  onPickCommunity(e: WechatMiniprogram.PickerChange) {
    this.applyCommunity(Number(e.detail.value), { keepBuilding: false });
  },

  applyCommunity(index: number, opts: { keepBuilding: boolean }) {
    const community = this.communities[index];
    if (!community) return;
    const patch: Record<string, unknown> = {
      communityIndex: index,
      communityId: community.id,
      communityName: community.name,
      // 弄跟着小区走，业主不用管
      lane: community.mainLane || '',
      laneHint: community.mainLane
        ? `${community.name}的楼栋都在 ${community.mainLane} 弄，只填几号楼就行`
        : '',
      placeText: communityLabel(community),
      'errors.place': '',
      'errors.building': '',
    };
    if (!opts.keepBuilding) {
      patch.buildingId = null;
      patch.buildingNo = '';
      patch.fromScan = false;
    }
    this.setData(patch);
  },

  /** 入驻的小区/楼栋：扫码带入，或业主自己选 */
  async resolveToken(token: string) {
    try {
      const info = await qr.resolve(token);
      const lane = info.building?.lane || '';
      const buildingNo = info.building?.buildingNo || '';
      const buildingText = buildingNo ? `${lane ? lane + '弄' : ''}${buildingNo}号` : '';
      this.setData({
        communityId: info.community?.id ?? null,
        communityName: info.community?.name ?? '',
        buildingId: info.building?.id ?? null,
        lane,
        buildingNo,
        fromScan: true,
        placeText: [info.community?.name, buildingText].filter(Boolean).join(' · '),
        prefillHint: '',
        'errors.place': '',
        'errors.building': '',
      });
      this.syncPickedCommunity();
    } catch (e: any) {
      this.setData({ 'errors.place': e?.message || '二维码无效，请重新扫码' });
    }
  },

  async onTapScan() {
    const token = await scanForToken();
    if (token) await this.resolveToken(token);
  },

  onInputBuildingNo(e: WechatMiniprogram.Input) {
    // 手改楼号后，扫码带出来的那个 buildingId 就不作数了，交给服务端按号重新匹配
    this.setData({
      buildingNo: e.detail.value,
      buildingId: null,
      fromScan: false,
      'errors.building': '',
    });
  },

  onInputRoom(e: WechatMiniprogram.Input) {
    this.setData({ roomNo: e.detail.value, 'errors.room': '' });
  },
  onInputName(e: WechatMiniprogram.Input) {
    this.setData({ realName: e.detail.value, 'errors.name': '' });
  },
  onInputPhone(e: WechatMiniprogram.Input) {
    this.setData({ phone: e.detail.value, phoneCode: '', 'errors.phone': '' });
  },

  onGetPhone(e: WechatMiniprogram.CustomEvent<{ code?: string }>) {
    if (e.detail?.code) {
      this.setData({ phoneCode: e.detail.code, phone: '', 'errors.phone': '' });
      wx.showToast({ title: '手机号已授权' });
    } else {
      this.setData({ 'errors.phone': '未授权手机号，可手动填写' });
    }
  },

  async onSubmit() {
    const { communityId, roomNo, phone, phoneCode } = this.data;
    const buildingNo = this.data.buildingNo.trim();
    const realName = this.data.realName.trim();
    const errors = {
      place: communityId ? '' : '请选择小区，或扫电梯里的二维码',
      building: buildingNo || this.data.buildingId ? '' : '请填写几号楼',
      room: roomNo.trim() ? '' : '请填写房号',
      name: realName ? '' : '请填写业主姓名，物业要核对房产登记信息',
      phone: phoneCode || PHONE_RE.test(phone) ? '' : '请授权或填写正确的手机号',
    };
    this.setData({ errors });
    if (errors.place || errors.building || errors.room || errors.name || errors.phone) return;

    this.setData({ submitting: true });
    try {
      await auth.ownerOnboard({
        communityId: communityId as number,
        buildingId: this.data.buildingId ?? undefined,
        // 只传号不传弄：服务端在该小区里按号匹配，住宅和商铺都能对上
        buildingNo: buildingNo || undefined,
        roomNo: roomNo.trim(),
        realName,
        phone: phoneCode ? undefined : phone,
        phoneCode: phoneCode || undefined,
      });
      saveDraft({
        communityId: communityId as number,
        buildingNo,
        roomNo: roomNo.trim(),
      });
      wx.showToast({ title: '已提交，等待物业审核' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 1200);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
