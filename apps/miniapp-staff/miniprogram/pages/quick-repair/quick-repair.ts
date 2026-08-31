import { repairs, upload } from '@pms/api-client';
import type { ParsedRepairAddress, PublicRepairType } from '@pms/api-client/src/endpoints/repairs';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
  classifyRepairType,
  detectUrgency,
  extractContact,
  extractFaultDescription,
  isVideoUrl,
  MAX_REPAIR_IMAGES,
  MAX_REPAIR_VIDEO_SECONDS,
  MAX_REPAIR_VIDEOS,
  urgencyReason,
} from '@pms/shared-types';
import { composeDetectedAddress, detectRepairAddress } from '../../utils/address-detect';

/**
 * 随手拍报修（员工端）：拍一张 / 录 15 秒 + 按住说一句话，说完就能提交。
 *
 * 和「我要报修」的分工：
 *   这里    = 现场巡查看到问题，手上不方便填表 —— 只做三件事（拍、说、提交），
 *             地址/类型/联系人/电话全部从那句话里认，认出来的才显示一行，认不出的才展开输入；
 *   我要报修 = 完整表单，逐项填/改。
 * 两个页面共用同一套识别：classifyRepairType（后台配的关键词，会自学习）、
 * detectRepairAddress（拿描述去撞库里真实的分期/楼栋/房号）、extractContact（人和电话）。
 *
 * 语音走微信官方「同声传译」插件，只支持普通话；插件没装时隐藏语音按钮，打字照常可用。
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

/** 识别出来的一行：认出来了才显示，认不出就不占地方 */
interface FoundRow {
  key: string;
  label: string;
  value: string;
}

Page({
  data: {
    content: '',
    /** 剥掉地址/联系人/电话/语气词之后的故障描述 —— 提交的是它，不是整句原话 */
    description: '',
    /** 语音识别的实时中间结果，让人知道在听 */
    partial: '',
    recording: false,
    hasSpeech: !!speechManager,

    attachments: [] as string[],
    mediaList: [] as Array<{ url: string; video: boolean }>,
    videoCount: 0,
    uploading: false,

    /** 认出来的四项，用于「已认出」那张卡 */
    found: [] as FoundRow[],
    /** 一样都没认出来时才展开手填 */
    needManual: false,
    /** 认出来的地址（撞过库的，带 id） */
    detected: null as ParsedRepairAddress | null,
    typeLabel: '',
    contactName: '',
    contactPhone: '',
    /**
     * 说了「急修 / 加急 / 抢修」就把这单标成紧急（判定见 shared-types 的 detectUrgency，
     * 所有报修入口共用一份）。认出来才显示那一行，点一下取消、再点标回来 ——
     * 认错了必须能改，改完提交的字段跟着走。
     */
    urgent: false,
    urgentMatched: '',
    urgentReasonText: '',

    submitting: false,
    errorMsg: '',
    maxImages: MAX_REPAIR_IMAGES,
    maxVideoSeconds: MAX_REPAIR_VIDEO_SECONDS,
  },

  /** 后台配的报修类型（带关键词），用于自动判定 */
  types: [] as PublicRepairType[],
  /** 端上判出来的类型，提交时带上：和最终落库的不一致就是一条负样本 */
  predictedType: '',
  /** 人自己点过「紧急」那一行之后，就别再被自动判定覆盖 */
  urgentTouched: false,
  detectTimer: 0,

  onLoad() {
    this.bindSpeech();
    this.loadTypes();
  },

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  async loadTypes() {
    try {
      this.types = await repairs.types();
    } catch {
      this.types = [];
    }
  },

  // ---------------- 拍 ----------------

  /**
   * 拍照 / 拍视频。视频限 15 秒：现场情况十几秒就说清了，
   * 拍长了上传慢、维修工也不会看完。
   */
  async onCapture(e: WechatMiniprogram.BaseEvent) {
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
    } catch (err: any) {
      wx.showToast({ icon: 'none', title: err?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  setAttachments(list: string[]) {
    this.setData({
      attachments: list,
      mediaList: list.map((url) => ({ url, video: isVideoUrl(url) })),
      videoCount: list.filter((url) => isVideoUrl(url)).length,
      errorMsg: '',
    });
  },

  onRemoveMedia(e: WechatMiniprogram.BaseEvent) {
    const next = this.data.attachments.slice();
    next.splice(Number(e.currentTarget.dataset.index), 1);
    this.setAttachments(next);
  },

  /** 视频丢进 previewImage 是一片黑，只有图片走预览 */
  onPreviewMedia(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    if (isVideoUrl(url)) return;
    wx.previewImage({
      current: url,
      urls: this.data.attachments.filter((item) => !isVideoUrl(item)),
    });
  },

  // ---------------- 说 ----------------

  bindSpeech() {
    if (!speechManager) return;
    hold = createHoldToTalk(speechManager);
    speechManager.onStart = () => {
      this.setData({ recording: true, partial: '' });
      // 首次授权时 touchend 被授权框吃掉，这里会替它补 stop（见 createHoldToTalk 注释）
      hold?.started();
    };
    speechManager.onRecognize = (res: { result: string }) => {
      this.setData({ partial: res.result || '' });
    };
    speechManager.onStop = (res: { result: string }) => {
      hold?.ended();
      const text = (res.result || this.data.partial || '').trim();
      this.setData({ recording: false, partial: '' });
      if (!text) return;
      // 接着上一段说：一次没说完可以按第二次
      const next = [this.data.content.trim(), text].filter(Boolean).join('，');
      this.onContentChanged(next);
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

  onInput(e: WechatMiniprogram.Input) {
    this.onContentChanged(e.detail.value);
  },

  // ---------------- 认 ----------------

  onContentChanged(text: string) {
    this.setData({ content: text, errorMsg: '' });

    // 类型和联系人是纯本地正则，每次输入都跟着认
    const hit = this.types.length ? classifyRepairType(text, this.types) : null;
    const contact = extractContact(text);
    const urgency = detectUrgency(text);
    this.predictedType = hit?.repairType || '';
    this.setData({
      typeLabel: hit?.label || '',
      contactName: contact.name || '',
      contactPhone: contact.phone || '',
      urgentMatched: urgency.matched,
      urgentReasonText: urgencyReason(urgency.matched),
      // 人自己定过紧急就不再自动改
      ...(this.urgentTouched ? {} : { urgent: urgency.urgent }),
    });

    // 地址要问服务端撞库，防抖 400ms
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = setTimeout(() => this.detectAddress(text), 400) as unknown as number;
    this.refreshFound();
  },

  async detectAddress(text: string) {
    const res = await detectRepairAddress(text);
    // 结果回来时话可能已经变了，只认最新一次
    if (text !== this.data.content) return;
    // 语音把小区名听成同音字（「枫桦」→「风华」）时，服务端给回正名版本。
    // 只有靠分期/弄这类数字撞上库的才会给 —— 名字是跟着数字改的，不是猜的。
    // 改完的话仍然落在可编辑的框里，人一眼能看出被改了什么、不对就自己改回去。
    if (res?.correctedText && res.correctedText !== text) {
      this.setData({ content: res.correctedText, detected: res });
      wx.showToast({ title: '已按小区名单更正', icon: 'none' });
      this.refreshFound();
      return;
    }
    this.setData({ detected: res });
    this.refreshFound();
  },

  /** 把认出来的拼成「已认出」那张卡；一样都没认出来才展开手填 */
  refreshFound() {
    const { detected, typeLabel, contactName, contactPhone, content } = this.data;
    // 故障描述 = 整句话剥掉已经认走的地址、联系人、电话，再剥语气词。
    // 「业主张先生报修一期47号大门关不上电话138…」→ 描述只剩「大门关不上」，
    // 不然后台看单的人要在一串人名电话里自己找故障是什么
    const contact = extractContact(content);
    /**
     * 故障描述：后台开了 AI 辅助识别就用模型理顺的那一句，否则走规则剥。
     * 模型强在「把口语理成通顺的一句话」，规则强在「一个字都不改地剥掉已认走的片段」——
     * 模型没给（没开、超时、调不通）时无缝退回规则，用户看不出区别。
     */
    const ruleDescription = extractFaultDescription(content, {
      // 用原话里的那一段，不是归一化的 matchedText ——
      // 后者不含小区名，剥完描述里会剩个「枫桦景苑」
      addressText: detected?.matchedRaw || detected?.matchedText,
      phoneText: contact.phoneText,
      nameText: contact.nameText,
    });
    const description = (detected?.ai?.description || '').trim() || ruleDescription;
    const found: FoundRow[] = [];
    // 地址只在真撞上库时才显示：模型给的地址服务端已经拿去撞过一遍了，
    // 撞不上就是 matched=false —— 那种情况下宁可不填，也不能让师傅按一个编出来的门牌去找
    if (detected?.matched) {
      found.push({ key: 'addr', label: '报修地址', value: composeDetectedAddress(detected) });
    }
    if (description && description !== content.trim()) {
      found.push({ key: 'desc', label: '故障描述', value: description });
    }
    if (typeLabel) found.push({ key: 'type', label: '报修类型', value: typeLabel });
    // 联系人：规则没抽到时用模型的。模型被要求「没说人名就留空、绝不拿地址数字充数」
    const name = contactName || (detected?.ai?.contactName || '').trim();
    if (name) found.push({ key: 'name', label: '联系人', value: name });
    if (contactPhone) found.push({ key: 'phone', label: '联系电话', value: contactPhone });
    this.setData({
      found,
      description,
      contactName: name,
      needManual: !!this.data.content.trim() && !detected?.matched,
    });
  },

  /** 判错了点一下取消，想标回去再点一下 */
  onToggleUrgent() {
    this.urgentTouched = true;
    this.setData({ urgent: !this.data.urgent });
  },

  /** 认错了就整单改到「我要报修」去逐项改，别在这一屏里堆一套表单 */
  onEditInFull() {
    // content 给「问题描述」框（已经剥掉地址/人名/电话，只剩故障本身），
    // raw 是原话 —— 完整表单要拿它重新认地址、联系人、电话、类型。
    // 2026-08-31 之前只传剥干净的那份，等于把信息删掉再让下一页去猜：
    // 联系人电话抽不出来，就被登录人的默认值顶上了，转过去一看全是自己。
    const q = [
      `content=${encodeURIComponent(this.data.description || this.data.content)}`,
      `raw=${encodeURIComponent(this.data.content)}`,
      `attachments=${encodeURIComponent(this.data.attachments.join(','))}`,
    ].join('&');
    wx.redirectTo({ url: `/pages/repair-create/repair-create?${q}` });
  },

  // ---------------- 提交 ----------------

  async onSubmit() {
    const content = this.data.content.trim();
    if (content.length < 5) {
      return this.setData({ errorMsg: '按住说一句话，或直接打字（至少 5 个字）' });
    }
    const { detected } = this.data;
    if (!detected) {
      return this.setData({
        errorMsg: '这句话里没认出小区房号。说清楚「几期几号几室」再试一次，或点下面改用完整表单',
      });
    }

    this.setData({ submitting: true, errorMsg: '' });
    try {
      await repairs.create({
        communityId: detected.communityId!,
        buildingId: detected.buildingId ?? undefined,
        houseId: detected.houseId ?? undefined,
        addressText: composeDetectedAddress(detected),
        contactName: this.data.contactName || undefined,
        contactPhone: this.data.contactPhone || undefined,
        repairType: this.predictedType || undefined,
        predictedRepairType: this.predictedType || undefined,
        // 说了「急修」就按紧急提交；人点掉了就是 false —— 端上传什么服务端认什么
        urgent: this.data.urgent,
        // 提交剥干净的描述；剥过头（空了）就退回原话
        content: this.data.description || content,
        attachments: this.data.attachments,
      });
      wx.showToast({ title: '已提交' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
