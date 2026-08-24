import { auth, repairs, upload } from '@pms/api-client';
import type {
  ParsedRepairAddress,
  PublicRepairType,
} from '@pms/api-client/src/endpoints/repairs';
import {
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  REPAIR_TYPE_OPTIONS,
} from '@pms/shared-types';
import {
  ADDRESS_HINT_RE,
  composeDetectedAddress,
  detectRepairAddress,
} from '../../utils/address-detect';
import { loadAddressBook } from '../../utils/address-picker';

/**
 * 员工端报修：维修工 / 办公室巡查发现问题顺手提单。
 *
 * 地址选法照搬业主端「一键报修」的工作人员模式 —— 三级地址簿，全公司范围，
 * 任何一级都能停下（停在小区/楼栋 = 公共区域）；描述里说了地址（「一期24号大门」）
 * 同样自动识别并覆盖手选位置（判断口径见 utils/address-detect）。
 * 联系人默认是本人；工单来源标为「员工小程序提交」，身份会标成「xx（维修工代报）」。
 * 语音输入暂未接：同声传译插件要在员工端小程序后台单独添加，先打字。
 */

const PHONE_RE = /^1[3-9]\d{9}$/;

interface PickedPlace {
  communityId: number;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  houseId: number | null;
  roomNo: string;
  fullText: string;
  isPublicArea: boolean;
}

Page({
  data: {
    communityId: null as number | null,
    buildingId: null as number | null,
    houseId: null as number | null,
    placeText: '',
    bookReady: false,
    bookLoading: true,

    /** 只有停在小区/楼栋级（公共区域）才问「具体在哪」 */
    showSpot: false,
    spotText: '',
    spotSuggestions: DEFAULT_LOCATION_SUGGESTIONS,

    contactName: '',
    contactPhone: '',

    typeOptions: REPAIR_TYPE_OPTIONS as Array<{ value: string; label: string }>,
    typeLabels: REPAIR_TYPE_OPTIONS.map((item) => item.label),
    typeIndex: -1,
    content: '',
    contentSuggestions: DEFAULT_CONTENT_SUGGESTIONS,
    contentSuggestTitle: '猜你想输',

    /** 描述里识别出的地址；识别到就替换手选位置展示，点 × 恢复 */
    detected: null as ParsedRepairAddress | null,

    attachments: [] as string[],
    uploading: false,
    submitting: false,
    errors: { place: '', type: '', content: '', phone: '' },
  },

  types: [] as PublicRepairType[],
  detectTimer: 0 as number,
  dismissedMatch: '' as string,

  onLoad() {
    this.loadBook();
    this.loadTypes();
    this.loadMe();
  },

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  /** 员工有租户归属，不传小区就是整个公司的地址簿（不含业主信息） */
  async loadBook() {
    try {
      const book = await loadAddressBook();
      this.setData({ bookReady: book.length > 0, bookLoading: false }, () => {
        // 组件是 wx:if 出来的，setData 回调里才拿得到实例
        const picker = this.selectComponent('#placePicker');
        if (picker) picker.setBook(book);
      });
    } catch (e: any) {
      this.setData({ bookLoading: false });
      wx.showToast({ icon: 'none', title: e?.message || '地址簿加载失败，下拉重试' });
    }
  },

  async loadTypes() {
    try {
      const types = await repairs.types();
      if (!types.length) return;
      this.types = types;
      this.setData({
        typeOptions: types.map((item) => ({ value: item.repairType, label: item.label })),
        typeLabels: types.map((item) => item.label),
      });
    } catch {
      // 拉不到就用内置类型，别挡住报修
    }
  },

  /** 联系人默认本人：系统已知的直接预填，允许改 */
  async loadMe() {
    try {
      const me = await auth.me();
      this.setData({ contactName: me.name || '', contactPhone: me.phone || '' });
    } catch {
      // 拿不到就让人自己填
    }
  },

  onPullDownRefresh() {
    this.loadBook().finally(() => wx.stopPullDownRefresh());
  },

  // ---------------- 位置 ----------------

  onPlacePicked(e: WechatMiniprogram.CustomEvent<PickedPlace>) {
    const picked = e.detail;
    this.setData({
      communityId: picked.communityId,
      buildingId: picked.buildingId,
      houseId: picked.houseId,
      placeText: picked.fullText,
      showSpot: picked.isPublicArea,
      ...(picked.isPublicArea ? {} : { spotText: '' }),
      'errors.place': '',
    });
  },

  onSpotText(e: WechatMiniprogram.Input) {
    this.setData({ spotText: e.detail.value });
  },

  onPickSpot(e: WechatMiniprogram.BaseEvent) {
    this.setData({ spotText: String(e.currentTarget.dataset.text || '') });
  },

  // ---------------- 描述里的地址识别 ----------------

  scheduleDetect(content: string) {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    if (!ADDRESS_HINT_RE.test(content)) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    this.detectTimer = setTimeout(() => this.detectAddress(content), 400) as unknown as number;
  },

  async detectAddress(content: string) {
    const res = await detectRepairAddress(content, this.data.communityId ?? undefined);
    // 结果回来时文字可能已经变了，只认最新一次输入
    if (content !== this.data.content) return;
    if (!res) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    if (res.matchedText && res.matchedText === this.dismissedMatch) return;
    this.setData({ detected: res });
  },

  onDismissDetected() {
    this.dismissedMatch = this.data.detected?.matchedText || '';
    this.setData({ detected: null });
  },

  // ---------------- 类型与描述 ----------------

  onPickType(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    const type = this.types[index];
    const keywords = (type?.keywords || []).filter(Boolean).slice(0, 8);
    this.setData({
      typeIndex: index,
      'errors.type': '',
      contentSuggestions: keywords.length ? keywords : DEFAULT_CONTENT_SUGGESTIONS,
      contentSuggestTitle: type ? type.label + '·猜你想输' : '猜你想输',
    });
  },

  onPickContentTag(e: WechatMiniprogram.BaseEvent) {
    const text = String(e.currentTarget.dataset.text || '');
    this.setData({ content: text, 'errors.content': '' });
    this.scheduleDetect(text);
  },

  onContent(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value, 'errors.content': '' });
    this.scheduleDetect(e.detail.value);
  },

  onContactName(e: WechatMiniprogram.Input) {
    this.setData({ contactName: e.detail.value });
  },

  onPhone(e: WechatMiniprogram.Input) {
    this.setData({ contactPhone: e.detail.value, 'errors.phone': '' });
  },

  // ---------------- 附件 ----------------

  async onChooseMedia() {
    if (this.data.uploading) return;
    const res = await wx
      .chooseMedia({ count: 6, mediaType: ['image'], sourceType: ['album', 'camera'] })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;

    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setData({
        attachments: [...this.data.attachments, ...uploaded.map((item) => item.publicUrl)],
      });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemoveMedia(e: WechatMiniprogram.BaseEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const next = this.data.attachments.slice();
    next.splice(idx, 1);
    this.setData({ attachments: next });
  },

  onPreviewMedia(e: WechatMiniprogram.BaseEvent) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: this.data.attachments });
  },

  // ---------------- 提交 ----------------

  async onSubmit() {
    const { communityId, typeIndex, content, contactPhone, detected } = this.data;
    const errors = {
      place: communityId || detected ? '' : '请先选择报修位置',
      type: typeIndex < 0 ? '请选择报修类型' : '',
      content: content.trim().length >= 5 ? '' : '请至少填写 5 个字描述问题',
      phone: contactPhone && !PHONE_RE.test(contactPhone) ? '请填写正确的手机号' : '',
    };
    this.setData({ errors });
    if (errors.place || errors.type || errors.content || errors.phone) return;

    // 描述里识别到了地址就按识别结果提交（id 和文案一起换）；否则用地址簿选的
    const ids = detected
      ? { buildingId: detected.buildingId ?? undefined, houseId: detected.houseId ?? undefined }
      : { buildingId: this.data.buildingId ?? undefined, houseId: this.data.houseId ?? undefined };
    const addressText = detected
      ? composeDetectedAddress(detected, this.data.spotText)
      : [this.data.placeText, this.data.spotText.trim()].filter(Boolean).join(' ');

    this.setData({ submitting: true });
    try {
      const resp = await repairs.create({
        communityId: detected ? detected.communityId! : (communityId as number),
        ...ids,
        addressText,
        contactName: this.data.contactName.trim() || undefined,
        contactPhone: contactPhone || undefined,
        repairType: this.data.typeOptions[typeIndex].value,
        content: content.trim(),
        attachments: this.data.attachments,
      });
      wx.showToast({ title: '报修已提交' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + resp.workOrder.id });
      }, 600);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
