import { auth, repairs, upload } from '@pms/api-client';
import type {
  ParsedRepairAddress,
  PublicRepairType,
} from '@pms/api-client/src/endpoints/repairs';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
  AuditStatus,
  classifyRepairType,
  detectUrgency,
  extractFaultDescription,
  urgencyReason,
} from '@pms/shared-types';
import { detectRepairAddress, shouldDetectAddress } from '../../utils/address-detect';
import {
  composePlaceText,
  scopeHint,
  scopeIds,
  scopeOptions,
  type PlaceScope,
} from '../../utils/place-scope';
import { askSubscribeAfterSubmit, primeSubscribeTemplates } from '../../utils/unread';

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

/** 按住说话的按压状态机，bindSpeech() 里创建；插件不可用时一直是 null */
let hold: HoldToTalk | null = null;

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
    /**
     * 从描述里识别出来的报修地址（「一期24号302」→ 库里真实的楼栋/房号）。
     * 识别到就替换默认位置展示，提交时关联 id 跟着它走；点 × 恢复默认 ——
     * 默认值必须能改，改完提交的 id 也要跟着变，这是全局口径。
     */
    detected: null as ParsedRepairAddress | null,
    media: [] as Array<{ url: string; type: 'image' | 'video' }>,
    uploading: false,
    submitting: false,
    /**
      * 说了「急修 / 加急 / 抢修」就把这单标成紧急（判定见 shared-types 的 detectUrgency，
      * 所有报修入口共用一份）。识别到才显示那一行，点一下能取消、再点能标回来 ——
      * 自动填的默认值必须能改，改完提交的字段跟着走。
      */
    urgent: false,
    /** 命中的那个词，用来告诉用户「凭什么标成紧急」 */
    urgentMatched: '',
    urgentReasonText: '',
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
  /** 地址识别的防抖定时器 */
  detectTimer: 0 as number,
  /** 用户点过 × 的识别片段：同一段文字不再弹出来烦人 */
  dismissedMatch: '' as string,
  /** 人自己点过「紧急」那一行之后，就别再被自动判定覆盖 */
  urgentTouched: false,

  onLoad() {
    // 提前把订阅模板拿好：提交时授权框要在点击里同步唤起，来不及再去请求
    primeSubscribeTemplates();
    this.bindSpeech();
  },

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const me = await auth.me();
      const place = me.place;
      // 业主端只有业主。保安/居委会/业委会/物业工作人员 2026-08-24 起走员工端
      // 小程序报修，这里不再有「不住这儿的人」需要特殊照顾的分支。
      if (!place?.communityId) {
        this.setData({
          ready: true,
          needOnboard: true,
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
    // 说过的话、拍好的照片一起带过去。2026-08-31 之前什么都不传，
    // 转过去要从头再说一遍、再拍一遍 —— 老人尤其吃不消
    const params: string[] = [];
    const content = this.data.content.trim();
    if (content) params.push(`content=${encodeURIComponent(content)}`);
    const attachments = this.data.media.map((item) => item.url).filter(Boolean);
    if (attachments.length) params.push(`attachments=${encodeURIComponent(attachments.join(','))}`);
    const query = params.length ? `?${params.join('&')}` : '';
    wx.navigateTo({ url: `/pages/repair-create/repair-create${query}` });
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
    hold = createHoldToTalk(speechManager);
    speechManager.onStart = () => {
      this.setData({ recording: true, partial: '' });
      // 首次授权时 touchend 被授权框吃掉，这里替它补 stop（见 createHoldToTalk 注释）
      hold?.started();
    };
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ partial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      hold?.ended();
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
      this.refreshUrgency(next);
      this.scheduleDetect(next);
      this.refreshSubmittable();
    };
    speechManager.onError = (err: { msg?: string; retcode?: number }) => {
      hold?.ended();
      this.setData({ recording: false, partial: '' });
      // 云端识别，网差必失败：先探网络，网差就明说，别让人以为自己没说清
      speechErrorTip(err).then((title) => wx.showToast({ icon: 'none', title, duration: 3000 }));
    };
  },

  onSpeechStart() {
    hold?.press();
  },

  /** touchend 和 touchcancel 都指到这里：手指滑出按钮、被来电打断也要收尾 */
  onSpeechEnd() {
    hold?.release();
  },

  // ---------------- 描述与类型 ----------------

  onContent(e: WechatMiniprogram.Input) {
    const value = e.detail.value;
    this.setData({ content: value });
    this.guess(value);
    this.refreshUrgency(value);
    this.scheduleDetect(value);
    this.refreshSubmittable();
  },

  // ---------------- 紧急 ----------------

  /** 描述里说了「急修」就标紧急；人自己定过就不再自动改 */
  refreshUrgency(content: string) {
    const hit = detectUrgency(content);
    this.setData({
      urgentMatched: hit.matched,
      urgentReasonText: urgencyReason(hit.matched),
      ...(this.urgentTouched ? {} : { urgent: hit.urgent }),
    });
  },

  /** 判错了点一下取消，想标回去再点一下 */
  onToggleUrgent() {
    this.urgentTouched = true;
    this.setData({ urgent: !this.data.urgent });
  },

  // ---------------- 描述里的地址识别 ----------------

  /**
   * 描述里出现「一期 / 198弄 / 24号」这类片段时，让服务端拿真实楼栋房号来对。
   * 端上先用正则粗筛 + 400ms 防抖，别每敲一个字就打一次接口。
   * 判断口径见 utils/address-detect，新增报修入口直接引那里。
   */
  scheduleDetect(content: string) {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    if (!shouldDetectAddress(content)) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    this.detectTimer = setTimeout(() => this.detectAddress(content), 400) as unknown as number;
  },

  async detectAddress(content: string) {
    const res = await detectRepairAddress(content, this.place?.communityId);
    // 结果回来时文字可能已经变了，只认最新一次输入
    if (content !== this.data.content) return;
    if (!res) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    // 用户点过 × 的同一段地址不再弹出来
    if (res.matchedText && res.matchedText === this.dismissedMatch) return;
    // 语音把小区名听成同音字时，服务端给回正名版本，直接换掉描述里的错字。
    // 只有靠分期/弄这类数字撞上库的才会给，名字是跟着数字改的、不是猜的；
    // 改完仍在可编辑的框里，不对就自己改回去
    if (res.correctedText && res.correctedText !== content) {
      this.setData({ content: res.correctedText, detected: res });
      wx.showToast({ title: '已按小区名单更正', icon: 'none' });
      return;
    }
    this.setData({ detected: res });
  },

  /** 点 × 撤掉识别结果，回到默认位置（我家 / 手选范围） */
  onDismissDetected() {
    this.dismissedMatch = this.data.detected?.matchedText || '';
    this.setData({ detected: null });
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
    const detected = this.data.detected;
    // 订阅授权框必须由这次点击同步唤起，放到提交请求之后微信就不认了（见 utils/unread.ts）
    askSubscribeAfterSubmit();
    this.setData({ submitting: true });
    try {
      const resp = await repairs.create({
        // 描述里识别到了地址就按识别结果提交（id 和文案一起换，不能只换显示）；
        // 否则维持默认：公共区域的单不能挂到业主房号上 —— 挂了工单看着像入户维修，
        // 维修工会去敲门，统计上也把公区故障算进了这户
        communityId: detected?.matched ? detected.communityId! : this.place.communityId,
        ...(detected?.matched
          ? {
              buildingId: detected.buildingId ?? undefined,
              houseId: detected.houseId ?? undefined,
            }
          : scopeIds(scope, this.place)),
        addressText: detected?.matched ? detected.addressText : this.data.placeText,
        repairType: this.guessType || undefined,
        // 说了「急修」就按紧急提交；人点掉了就是 false —— 端上传什么服务端认什么
        urgent: this.data.urgent,
        // 描述里认出来的地址已经单独提交了，从描述里剥掉，顺带剥语音带进来的语气词；
        // 只拍照没打字时给一句占位，后端要求 content 非空
        content:
          extractFaultDescription(content, {
            // matchedRaw 是地址在原话里占的整段（含小区名），剥得干净
            addressText: detected?.matched ? detected.matchedRaw || detected.matchedText : undefined,
          }) ||
          '业主随手拍报修，详见照片',
        attachments,
      });
      wx.showToast({ title: '已提交' });
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
