import { auth, repairs, upload } from '@pms/api-client';
import type {
  ParsedRepairAddress,
  PublicRepairType,
} from '@pms/api-client/src/endpoints/repairs';
import {
  classifyRepairType,
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  extractContact,
  isVideoUrl,
  MAX_REPAIR_IMAGES,
  MAX_REPAIR_VIDEO_SECONDS,
  MAX_REPAIR_VIDEOS,
  REPAIR_TYPE_OPTIONS,
} from '@pms/shared-types';
import {
  ADDRESS_HINT_RE,
  composeDetectedAddress,
  detectRepairAddress,
} from '../../utils/address-detect';
import { speechErrorTip } from '@pms/miniapp-ui';
import { loadAddressBook } from '../../utils/address-picker';

/**
 * 员工端报修：维修工 / 办公室巡查发现问题顺手提单。
 *
 * 地址选法照搬业主端「一键报修」的工作人员模式 —— 三级地址簿，全公司范围，
 * 任何一级都能停下（停在小区/楼栋 = 公共区域）；描述里说了地址（「一期24号大门」）
 * 同样自动识别并覆盖手选位置（判断口径见 utils/address-detect）。
 * 联系人默认是本人；工单来源标为「员工小程序提交」，身份会标成「xx（维修工代报）」。
 * 语音输入走微信「同声传译」插件（普通话），识别结果落到可编辑文本框。
 */

/**
 * 语音输入用微信官方「同声传译」插件（员工端小程序后台已添加）。
 * 插件只支持普通话 / 英文 / 粤语，没有上海话，所以按钮上写明「普通话」，
 * 识别结果一律落到可编辑的文本框里，说不准能自己改。
 * 插件加载失败（比如后台被移除）时 requirePlugin 抛错，捕获后隐藏语音按钮，打字照常。
 */
let speechManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  speechManager = requirePlugin('WechatSI').getRecordRecognitionManager();
} catch {
  speechManager = null;
}

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

    /** 「一句话填单」的识别痕迹，摆出来让人核对：判成什么类型、按哪个词判的 */
    autoTypeHint: '',
    /** 联系人/电话是自动填的，提示一句，认错了好改 */
    autoContactHint: '',

    hasSpeech: !!speechManager,
    recording: false,
    /** 语音识别的实时中间结果，让用户知道在听 */
    partial: '',

    attachments: [] as string[],
    /** 和 attachments 一一对应的渲染用数据：wxml 里调不了 isVideoUrl */
    mediaList: [] as Array<{ url: string; video: boolean }>,
    videoCount: 0,
    uploading: false,
    submitting: false,
    errors: { place: '', type: '', content: '', phone: '' },
    /** 代报角色才有值：提示他能报哪几个小区 */
    scopeHint: '',
  },

  types: [] as PublicRepairType[],
  /** 人手动选过类型 / 改过联系人电话，之后自动识别一律不覆盖 */
  typePickedByUser: false,
  /** 系统自动判出来的类型编码，提交时随单带上做负样本比对 */
  predictedType: '',
  contactTouched: false,
  phoneTouched: false,
  /** 代报角色的授权小区；空数组 = 不限（物业员工） */
  reportCommunityIds: [] as number[],
  detectTimer: 0 as number,
  dismissedMatch: '' as string,

  onLoad() {
    this.bindSpeech();
    this.loadTypes();
    // 地址簿范围取决于身份（代报角色只能报授权小区），所以先 me() 再拉地址簿，
    // 别并行 —— 并行的话保安会先看到全公司地址簿，选完提交才被后端拦下
    this.loadMe().then(() => this.loadBook());
  },

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  /**
   * 员工有租户归属，不传小区就是整个公司的地址簿（不含业主信息）。
   * 保安/居委会/业委会只能报授权小区，就按授权小区逐个拉再拼起来 ——
   * 让人选得到却提不了，比一开始就看不到更难受。
   */
  async loadBook() {
    try {
      const scope = this.reportCommunityIds;
      const book = scope.length
        ? (await Promise.all(scope.map((id) => loadAddressBook(id).catch(() => [])))).flat()
        : await loadAddressBook();
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

  /** 联系人默认本人：系统已知的直接预填，允许改。顺带取回代报授权范围 */
  async loadMe() {
    try {
      const me = await auth.me();
      const grants = me.reporter?.communities || [];
      this.reportCommunityIds = grants.map((c) => c.id);
      this.setData({
        contactName: me.name || '',
        contactPhone: me.phone || '',
        scopeHint: this.reportCommunityIds.length
          ? `你可报修的范围：${grants.map((c) => c.name).join('、')}`
          : '',
      });
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

  /**
   * 「一句话填单」：从描述里把能认的都认出来，认不出的就不动。
   *
   * 类型走 classifyRepairType，依据是后台配的「猜你想输」关键词 —— 那份词表本身
   * 由历史报修归纳出来（见 /repair-suggestions），所以单子越多判得越准，
   * 不用另外维护一张分类词表。
   * 联系人和电话走 extractContact（中文数字、分隔符都处理过）。
   *
   * 三条硬规矩：
   * 1. 人手动选过/填过的，绝不覆盖 —— 自动识别只负责省事，不负责跟人抢方向盘；
   * 2. 认出来的都留一句提示（按哪个词判的、谁是自动填的），认错时一眼能看见；
   * 3. 认不出就保持空白，不瞎猜。
   */
  autoFillFromText(content: string) {
    const text = String(content || '').trim();
    if (!text) return;

    // ---- 报修类型 ----
    if (!this.typePickedByUser && this.types.length) {
      const hit = classifyRepairType(text, this.types);
      if (hit) {
        const index = this.types.findIndex((item) => item.repairType === hit.repairType);
        if (index >= 0 && index !== this.data.typeIndex) {
          const keywords = (this.types[index].keywords || []).filter(Boolean).slice(0, 8);
          this.setData({
            typeIndex: index,
            'errors.type': '',
            contentSuggestions: keywords.length ? keywords : DEFAULT_CONTENT_SUGGESTIONS,
            contentSuggestTitle: hit.label + '·猜你想输',
            autoTypeHint: `按「${hit.matched.slice(0, 2).join('、')}」自动判为${hit.label}，不对可改`,
          });
          // 记下来：提交时和人最终选的一比，不一致就是一条负样本
          this.predictedType = hit.repairType;
        }
      }
    }

    // ---- 联系人 / 电话 ----
    const contact = extractContact(text);
    const patch: Record<string, string> = {};
    const filled: string[] = [];
    if (contact.name && !this.contactTouched && !this.data.contactName) {
      patch.contactName = contact.name;
      filled.push(`联系人 ${contact.name}`);
    }
    if (contact.phone && !this.phoneTouched && !this.data.contactPhone) {
      patch.contactPhone = contact.phone;
      patch['errors.phone'] = '';
      filled.push(`电话 ${contact.phone}`);
    }
    if (filled.length) {
      patch.autoContactHint = `已从描述里认出${filled.join('、')}，不对可直接改`;
      this.setData(patch);
    }
  },

  scheduleDetect(content: string) {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    // 类型/联系人/电话不受地址关键词限制，任何一次输入都跟着识别
    this.autoFillFromText(content);
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
    // 人手动选过，之后再改描述也不许自动覆盖
    this.typePickedByUser = true;
    const index = Number(e.detail.value);
    const type = this.types[index];
    const keywords = (type?.keywords || []).filter(Boolean).slice(0, 8);
    this.setData({
      typeIndex: index,
      'errors.type': '',
      contentSuggestions: keywords.length ? keywords : DEFAULT_CONTENT_SUGGESTIONS,
      contentSuggestTitle: type ? type.label + '·猜你想输' : '猜你想输',
      autoTypeHint: '',
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
    this.contactTouched = true;
    this.setData({ contactName: e.detail.value, autoContactHint: '' });
  },

  onPhone(e: WechatMiniprogram.Input) {
    this.phoneTouched = true;
    this.setData({ contactPhone: e.detail.value, 'errors.phone': '', autoContactHint: '' });
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
      // 追加而不是覆盖，允许说好几段；说完顺手做一次地址识别
      const next = this.data.content ? this.data.content + text : text;
      this.setData({ content: next, 'errors.content': '' });
      this.scheduleDetect(next);
    };
    speechManager.onError = (err: { msg?: string; retcode?: number }) => {
      this.setData({ recording: false, partial: '' });
      // 云端识别，网差必失败：先探网络，网差就明说，别让人以为自己没说清
      speechErrorTip(err).then((title) => wx.showToast({ icon: 'none', title, duration: 3000 }));
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

  // ---------------- 附件 ----------------

  /** attachments 变了就同步渲染用的那份，别让两处各算各的 */
  setAttachments(list: string[]) {
    this.setData({
      attachments: list,
      mediaList: list.map((url) => ({ url, video: isVideoUrl(url) })),
      videoCount: list.filter((url) => isVideoUrl(url)).length,
    });
  },

  /**
   * 拍照 / 拍视频。data-type="video" 走视频，其余走图片。
   * 视频限 15 秒：现场情况一段十几秒就说清了，拍长了上传慢、维修工也不会看完。
   */
  async onChooseMedia(e: WechatMiniprogram.BaseEvent) {
    if (this.data.uploading) return;
    const wantVideo = e.currentTarget.dataset.type === 'video';
    const images = this.data.attachments.length - this.data.videoCount;
    if (wantVideo && this.data.videoCount >= MAX_REPAIR_VIDEOS) {
      return wx.showToast({ icon: 'none', title: `最多 ${MAX_REPAIR_VIDEOS} 段视频` });
    }
    if (!wantVideo && images >= MAX_REPAIR_IMAGES) {
      return wx.showToast({ icon: 'none', title: `最多 ${MAX_REPAIR_IMAGES} 张照片` });
    }

    const res = await wx
      .chooseMedia({
        count: wantVideo ? 1 : MAX_REPAIR_IMAGES - images,
        mediaType: [wantVideo ? 'video' : 'image'],
        sourceType: ['camera', 'album'],
        maxDuration: MAX_REPAIR_VIDEO_SECONDS,
        camera: 'back',
      })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;

    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((f) => f.tempFilePath));
      this.setAttachments([...this.data.attachments, ...uploaded.map((item) => item.publicUrl)]);
    } catch (e2: any) {
      wx.showToast({ icon: 'none', title: e2?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemoveMedia(e: WechatMiniprogram.BaseEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const next = this.data.attachments.slice();
    next.splice(idx, 1);
    this.setAttachments(next);
  },

  /** 视频点开是全屏播放，图片才走 previewImage —— 视频丢进 previewImage 是一片黑 */
  onPreviewMedia(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    if (isVideoUrl(url)) return;
    wx.previewImage({ current: url, urls: this.data.attachments.filter((item) => !isVideoUrl(item)) });
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
        // 把「系统当初判的是什么」一并带上：和最终选的不一致时，
        // 后端记一条负样本，下次这个词就不会再往错的类型上撞
        predictedRepairType: this.predictedType || undefined,
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
