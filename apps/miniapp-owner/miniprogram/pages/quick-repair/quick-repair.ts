import { auth, repairs, upload } from '@pms/api-client';
import type { PublicRepairType } from '@pms/api-client/src/endpoints/repairs';
import { AuditStatus, classifyRepairType } from '@pms/shared-types';
import {
  composePlaceText,
  scopeHint,
  scopeIds,
  scopeOptions,
  type PlaceScope,
} from '../../utils/place-scope';
import { askSubscribeAfterSubmit } from '../../utils/unread';

/**
 * 随手拍报修：拍一张照片或一段视频 + 一句话描述（可语音），点一下就提交。
 * 位置取业主已认证的房屋，报修类型按描述自动判定 —— 业主不用选任何下拉。
 *
 * 语音转文字用微信官方「同声传译」插件，需要在小程序管理后台
 *「设置 → 第三方设置 → 插件管理」添加 wx069ba97219f66d99。
 * 没添加时 requirePlugin 会抛错，这里捕获后隐藏语音按钮，打字照常可用。
 */
let speechManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  speechManager = requirePlugin('WechatSI').getRecordRecognitionManager();
} catch {
  speechManager = null;
}

const MAX_MEDIA = 3;

Page({
  data: {
    ready: false,
    placeText: '',
    /** 报修位置的三个范围，默认「我家里」，但可以改；口径见 utils/place-scope */
    scopes: scopeOptions(true),
    scope: 'home' as PlaceScope,
    scopeHint: '',
    /** 非「我家里」时补一句具体在哪，选填 */
    placeDetail: '',
    /** 没绑到楼栋时「本楼公共区域」无处可指，直接不给选 */
    hasBuilding: false,
    /**
     * 能选任意地址的账号（物业在后台标记过身份）。随手拍这种「拍完就提交」的
     * 形态塞不下一个地址选择器，这里只给个入口，跳到一键报修去选。
     * 不显示身份字样 —— 对他们来说这就是报修该有的样子。
     */
    canPickAnyPlace: false,
    /** 能选任意地址、名下又没有认证房屋：随手拍无从下手，直接引导去一键报修 */
    pickPlaceFirst: false,
    /** 认证审核中的提示：只提示，不拦报修 */
    pendingHint: '',
    /** 真的一套房都没提交过，才引导去认证 */
    needOnboard: false,
    canSubmit: false,
    hasSpeech: !!speechManager,
    recording: false,
    /** 语音识别的实时中间结果，让用户知道在听 */
    partial: '',
    content: '',
    media: [] as Array<{ url: string; type: 'image' | 'video' }>,
    uploading: false,
    submitting: false,
    /** 自动判定出来的类型，展示给用户并允许改 */
    guessLabel: '',
    guessReason: '',
    typeIndex: -1,
    typeLabels: [] as string[],
    errorMsg: '',
  },

  place: null as {
    communityId: number;
    communityName: string;
    buildingId: number | null;
    buildingText: string;
    houseId: number | null;
    homeText: string;
  } | null,
  types: [] as PublicRepairType[],
  guessType: '' as string,

  onLoad() {
    this.bindSpeech();
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const me = await auth.me();
      const place = me.place;
      if (me.reporter?.canReportOthers) {
        this.setData({ canPickAnyPlace: true });
      }
      if (!place?.communityId) {
        this.setData({
          ready: true,
          // 这些账号本来就不一定住这儿，别把他们往「认证房屋」上赶
          needOnboard: !me.reporter?.canReportOthers,
          pickPlaceFirst: !!me.reporter?.canReportOthers,
          errorMsg: '',
          canSubmit: false,
        });
        return;
      }
      this.place = {
        communityId: place.communityId,
        communityName: place.communityName || '',
        buildingId: place.buildingId,
        buildingText: place.buildingText || '',
        houseId: place.houseId,
        // 家里的地址文案由后端统一给（228弄26号101室），别在端上再拼一套，两边容易走样
        homeText: place.addressText || place.communityName || '',
      };
      const hasBuilding = !!place.buildingId;
      this.setData({
        ready: true,
        needOnboard: false,
        hasBuilding,
        scopes: scopeOptions(hasBuilding),
        // 审核中照样能报修：位置在申请里已经写清楚了，没道理再把人挡回认证页
        pendingHint: this.auditHint(place.auditStatus),
        errorMsg: '',
      });
      this.refreshPlaceText();
      this.refreshSubmittable();
      // 报修类型只是「自动判定」用的锦上添花，拿不到就交给物业核对，不能因此挡住报修
      this.loadTypes();
    } catch (e: any) {
      this.setData({
        ready: true,
        needOnboard: false,
        errorMsg: e?.message || '加载失败，下拉重试',
      });
    }
  },

  // ---------------- 报修位置 ----------------

  onPickScope(e: WechatMiniprogram.BaseEvent) {
    const scope = e.currentTarget.dataset.scope as PlaceScope;
    if (!scope || scope === this.data.scope) return;
    this.setData({ scope });
    this.refreshPlaceText();
  },

  onPlaceDetail(e: WechatMiniprogram.Input) {
    this.setData({ placeDetail: e.detail.value });
    this.refreshPlaceText();
  },

  /** 三个范围各自拼出上门地址；具体位置是业主补的那一句 */
  refreshPlaceText() {
    const place = this.place;
    if (!place) return;
    const scope = this.data.scope;
    this.setData({
      placeText: composePlaceText(scope, place, this.data.placeDetail),
      scopeHint: scopeHint(scope),
    });
  },

  /** 认证状态只作提示，不影响能不能提交 */
  auditHint(status: string): string {
    if (status === AuditStatus.PENDING) {
      return '房屋认证审核中，不影响报修，物业会按这个地址上门';
    }
    if (status === AuditStatus.REJECTED) {
      return '房屋认证未通过，报修照常受理，建议在「我的」里重新认证';
    }
    return '';
  },

  async loadTypes() {
    try {
      this.types = await repairs.types();
      this.setData({ typeLabels: this.types.map((item) => item.label) });
      if (this.data.content) this.guess(this.data.content);
    } catch {
      // 判不出类型就留空，后台按「其它」处理
      this.types = [];
      this.setData({ typeLabels: [] });
    }
  },

  onGoOnboard() {
    wx.navigateTo({ url: '/pages/onboard/onboard' });
  },

  /** 走完整报修表单（和网页后台一样逐项填） */
  onGoFullForm() {
    wx.navigateTo({ url: '/pages/repair-create/repair-create' });
  },

  onRetry() {
    this.load();
  },

  // ---------------- 拍照 / 录像 ----------------

  async onCapture(e: WechatMiniprogram.BaseEvent) {
    if (this.data.uploading) return;
    const mediaType = e.currentTarget.dataset.type === 'video' ? 'video' : 'image';
    const left = MAX_MEDIA - this.data.media.length;
    if (left <= 0) {
      return wx.showToast({ icon: 'none', title: `最多 ${MAX_MEDIA} 个附件` });
    }
    const res = await wx
      .chooseMedia({
        count: mediaType === 'video' ? 1 : left,
        mediaType: [mediaType],
        sourceType: ['camera', 'album'],
        maxDuration: 15,
        camera: 'back',
      })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;

    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setData({
        media: [
          ...this.data.media,
          ...uploaded.map((item) => ({ url: item.publicUrl, type: mediaType as 'image' | 'video' })),
        ],
      });
      this.refreshSubmittable();
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemoveMedia(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const media = this.data.media.slice();
    media.splice(index, 1);
    this.setData({ media });
    this.refreshSubmittable();
  },

  onPreviewMedia(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.media[Number(e.currentTarget.dataset.index)];
    if (!item) return;
    if (item.type === 'video') {
      wx.previewMedia({ sources: [{ url: item.url, type: 'video' }] });
      return;
    }
    wx.previewImage({
      current: item.url,
      urls: this.data.media.filter((m) => m.type === 'image').map((m) => m.url),
    });
  },

  // ---------------- 语音转文字 ----------------

  bindSpeech() {
    if (!speechManager) return;
    speechManager.onStart = () => this.setData({ recording: true, partial: '' });
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ partial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      const text = (res.result || '').trim();
      this.setData({ recording: false, partial: '' });
      if (!text) {
        wx.showToast({ icon: 'none', title: '没听清，再说一次或直接打字' });
        return;
      }
      // 追加而不是覆盖，允许说好几段
      const next = this.data.content ? `${this.data.content}${text}` : text;
      this.setData({ content: next });
      this.guess(next);
      this.refreshSubmittable();
    };
    speechManager.onError = (err: { msg?: string }) => {
      this.setData({ recording: false, partial: '' });
      wx.showToast({ icon: 'none', title: err?.msg || '语音识别失败，可直接打字' });
    };
  },

  onSpeechStart() {
    if (!speechManager || this.data.recording) return;
    speechManager.start({ lang: 'zh_CN', duration: 30000 });
  },

  onSpeechEnd() {
    if (!speechManager || !this.data.recording) return;
    speechManager.stop();
  },

  // ---------------- 描述与类型 ----------------

  onContent(e: WechatMiniprogram.Input) {
    const value = e.detail.value;
    this.setData({ content: value });
    this.guess(value);
    this.refreshSubmittable();
  },

  /** 按描述自动判定报修类型；判不出就留空，由后台按「其它」处理 */
  guess(content: string) {
    const hit = classifyRepairType(content, this.types);
    if (!hit) {
      this.guessType = '';
      this.setData({ guessLabel: '', guessReason: '', typeIndex: -1 });
      return;
    }
    this.guessType = hit.repairType;
    this.setData({
      guessLabel: hit.label,
      guessReason: hit.matched.length ? `识别到「${hit.matched[0]}」` : '',
      typeIndex: this.types.findIndex((item) => item.repairType === hit.repairType),
    });
  },

  /** 判错了可以自己改 */
  onPickType(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    const type = this.types[index];
    if (!type) return;
    this.guessType = type.repairType;
    this.setData({ typeIndex: index, guessLabel: type.label, guessReason: '已手动选择' });
  },

  refreshSubmittable() {
    const hasContent = this.data.content.trim().length >= 2;
    const hasMedia = this.data.media.length > 0;
    // 有图或有描述就能提交 —— 「随手拍」的意义就是别拦着人
    this.setData({ canSubmit: !!this.place && (hasContent || hasMedia) });
  },

  async onSubmit() {
    if (!this.place || this.data.submitting) return;
    const content = this.data.content.trim();
    const attachments = this.data.media.map((item) => item.url);
    if (!content && !attachments.length) {
      return wx.showToast({ icon: 'none', title: '拍张照片或说一句问题' });
    }

    const scope = this.data.scope;
    this.setData({ submitting: true });
    try {
      const resp = await repairs.create({
        communityId: this.place.communityId,
        // 公共区域的单不能挂到业主房号上：挂了工单看着像入户维修，
        // 维修工会去敲门，统计上也把公区故障算进了这户
        ...scopeIds(scope, this.place),
        addressText: this.data.placeText,
        repairType: this.guessType || undefined,
        // 只拍照没打字时给一句占位，后端要求 content 非空
        content: content || '业主随手拍报修，详见照片',
        attachments,
      });
      wx.showToast({ title: '已提交' });
      // 刚提交完是请求订阅授权的最佳时机：用户正期待「什么时候派单」，同意率最高。
      // 一进小程序就弹多半会被下意识拒绝，而微信的拒绝是持久的，弹错一次就没机会了。
      await askSubscribeAfterSubmit();
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${resp.workOrder.id}` });
      }, 600);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
});
