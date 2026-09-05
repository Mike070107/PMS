import { auth, qr, repairs, upload } from '@pms/api-client';
import type {
  ParsedRepairAddress,
  PublicRepairType,
} from '@pms/api-client/src/endpoints/repairs';
import {
  shouldDetectAddress,
  composeDetectedAddress,
  detectRepairAddress,
} from '../../utils/address-detect';
import {
  AuditStatus,
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  REPAIR_TYPE_OPTIONS,
  detectUrgency,
  extractContact,
  extractFaultDescription,
  formatReporterRoomLabel,
  urgencyReason,
} from '@pms/shared-types';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
  composePlaceText,
  isPublicScope,
  scopeHint,
  scopeIds,
  scopeOptions,
  type PlaceScope,
  type PlaceScopeOption,
} from '../../utils/place-scope';
import { scanForToken } from '../../utils/scan';
import { ensureOwnerLogin } from '../../utils/session';
import { askSubscribeAfterSubmit, primeSubscribeTemplates } from '../../utils/unread';

/**
 * 提交前把描述里的地址剥掉（员工端 repair-create 有一份一样的）。
 * 必须传 matchedRaw ——「地址在原话里占的整段」，含小区名；
 * 归一化的 matchedText 不含小区名，剥完会在描述开头剩个「枫桦景苑」。
 * 剥空了退回原文，不提交空描述。
 */
function stripAddress(content: string, matchedRaw?: string | null): string {
  const full = content.trim();
  if (!matchedRaw) return full;
  const stripped = extractFaultDescription(full, { addressText: matchedRaw }).trim();
  return stripped || full;
}

/**
 * 一键报修。字段顺序、"猜你想输"、地址选法都与管理后台「办公室录入报修」对齐，
 * 只是排成手机的样子；后台那张表单改了，这里跟着改。
 *
 * 两种模式：
 * - self：普通业主。位置只能是自己家或所在楼/小区的公共区域
 *   （服务端 assertCanReportAt 也是这么卡的，端上少给选项就少一次白填）。
 * - full：物业在后台标记过身份的人（保安/居委会/业委会/物业工作人员）。
 *   位置用和后台一样的三级选法，能选到授权小区里的任意楼栋/房号。
 *   端上不出现身份字样 —— 对他们来说这就是报修该有的样子。
 */

/**
 * 语音输入用微信官方「同声传译」插件。
 * 插件只支持普通话 / 英文 / 粤语，没有上海话等吴语方言，
 * 所以按钮上写明「普通话」，识别结果一律落到可编辑的文本框里，说不准能自己改。
 * 没在管理后台加插件时 requirePlugin 会抛错，捕获后隐藏语音按钮，打字照常可用。
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

interface PageData {
  token: string;
  booting: boolean;
  /**
   * 'self' = 普通业主，只在自己家/自己楼里选位置。
   * 'full' = 后台标记过身份的人用后台那套地址选法 —— 2026-08-24 代报角色迁到
   * 员工端后，业主端已经没有入口会切到 full，相关分支只是还没拆的旧结构。
   */
  mode: 'self' | 'full';
  notOnboarded: boolean;
  phoneMatchEnabled: boolean;
  phoneMatched: boolean;
  phoneMatchMsg: string;
  matching: boolean;

  // ---- 位置（self 模式） ----
  scope: PlaceScope;
  scopes: PlaceScopeOption[];
  scopeHint: string;
  placeDetail: string;
  homeText: string;
  roomNo: string;

  // ---- 位置（两种模式共用的结果） ----
  communityId: number | null;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  houseId: number | null;
  /** 展示用的完整地址 */
  placeText: string;
  /** full 模式下地址簿是否就绪 */
  bookReady: boolean;
  bookLoading: boolean;

  // ---- 具体位置 ----
  /** 只有公共区域才问「具体在哪」；报自己家时地址已精确到房号 */
  showSpot: boolean;
  spotText: string;
  spotSuggestions: string[];

  // ---- 联系方式 ----
  contactName: string;
  contactPhone: string;

  // ---- 类型与描述 ----
  typeOptions: Array<{ value: string; label: string }>;
  typeLabels: string[];
  typeIndex: number;
  content: string;
  contentSuggestions: string[];
  contentSuggestTitle: string;

  /**
   * 描述里说了「急修 / 加急 / 抢修」→ 这单按紧急处理（判定见 shared-types 的
   * detectUrgency，随手拍走的是同一份）。认出来才显示那一行，可以点掉、再点回来。
   */
  urgent: boolean;
  urgentMatched: string;
  urgentReasonText: string;

  /**
   * 从描述里识别出来的报修地址（「一期24号302」→ 库里真实的楼栋/房号）。
   * 识别到就替换上面选的位置展示，提交时关联 id 跟着它走；点 × 恢复 ——
   * 默认值必须能改，改完提交的 id 也要跟着变，这是全局口径。
   */
  detected: ParsedRepairAddress | null;

  hasSpeech: boolean;
  recording: boolean;
  partial: string;

  attachments: string[];
  uploading: boolean;
  submitting: boolean;
  errors: { place: string; type: string; content: string; phone: string };
}

Page<PageData, WechatMiniprogram.IAnyObject>({
  data: {
    token: '',
    booting: false,
    mode: 'self',
    notOnboarded: false,
    phoneMatchEnabled: false,
    phoneMatched: false,
    phoneMatchMsg: '',
    matching: false,

    scope: 'home',
    scopes: scopeOptions(false),
    scopeHint: '',
    placeDetail: '',
    homeText: '',
    roomNo: '',

    communityId: null,
    communityName: '',
    buildingId: null,
    buildingText: '',
    houseId: null,
    placeText: '',
    bookReady: false,
    bookLoading: false,

    showSpot: false,
    spotText: '',
    spotSuggestions: DEFAULT_LOCATION_SUGGESTIONS,

    contactName: '',
    contactPhone: '',

    typeOptions: REPAIR_TYPE_OPTIONS,
    typeLabels: REPAIR_TYPE_OPTIONS.map((item) => item.label),
    typeIndex: -1,
    content: '',
    contentSuggestions: DEFAULT_CONTENT_SUGGESTIONS,
    contentSuggestTitle: '猜你想输',
    urgent: false,
    urgentMatched: '',
    urgentReasonText: '',
    detected: null,

    hasSpeech: !!speechManager,
    recording: false,
    partial: '',

    attachments: [],
    uploading: false,
    submitting: false,
    errors: { place: '', type: '', content: '', phone: '' },
  },

  /** 地址簿放实例上，不进 data —— 1000+ 条 setData 会明显卡 */
  /** 后台配置的报修类型（带关键词，用于「猜你想输」） */
  types: [] as PublicRepairType[],
  /** 地址识别的防抖定时器 */
  detectTimer: 0 as number,
  /** 用户点过 × 的识别片段：同一段文字不再弹出来烦人 */
  dismissedMatch: '' as string,
  /** 人自己点过「紧急」那一行之后，就别再被自动判定覆盖 */
  urgentTouched: false,
  /** 联系人是业主自己改的时候，AI 识别不能覆盖 */
  contactTouched: false,
  phoneTouched: false,

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  onLoad(q: Record<string, string>) {
    // 提前把订阅模板拿好：提交时授权框要在点击里同步唤起，来不及再去请求
    primeSubscribeTemplates();
    this.bindSpeech();
    this.loadTypes();
    // 从「随手拍」转过来的话和照片：那边已经说过拍过，这里只是逐项改，
    // 不能让人从头再来一次（员工端 repair-create 同一套做法）
    const handoff = decodeURIComponent(q?.content || '').trim();
    const media = decodeURIComponent(q?.attachments || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (media.length) this.setData({ attachments: media });
    if (handoff) {
      this.setData({ content: handoff });
      this.scheduleDetect(handoff);
    }
    // 四种进入方式：
    // 1) 微信扫一扫楼栋小程序码（scene=token）—— 这时本页就是启动页，要自己登录并判断入驻状态
    // 2) 小程序内扫码带 token
    // 3) 首页带房屋参数
    // 4) 直接进来（回落到我的房屋）
    if (q.scene) {
      this.enterFromScan(decodeURIComponent(q.scene));
    } else if (q.token) {
      this.resolveToken(q.token);
    } else if (q.communityId) {
      this.setData({
        communityId: Number(q.communityId),
        buildingId: q.buildingId ? Number(q.buildingId) : null,
        // 首页带过来的是已认证房屋，houseId 一起带，否则工单挂不到这套房上
        houseId: q.houseId ? Number(q.houseId) : null,
        communityName: q.communityName ? decodeURIComponent(q.communityName) : '',
        buildingText: q.buildingText ? decodeURIComponent(q.buildingText) : '',
        homeText: q.place ? decodeURIComponent(q.place) : '',
        // 房号是已知的，直接填好；老人不用再去翻自己家门牌
        roomNo: q.roomNo ? decodeURIComponent(q.roomNo) : '',
      });
      this.refreshPlace();
    } else {
      this.loadMyPlace();
    }
  },

  // ---------------- 身份与地址簿 ----------------


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

  /** 没有扫码也没带参数时，用业主已认证的房屋 */
  async loadMyPlace() {
    try {
      const me = await auth.me();
      const place = me.place;
      if (place) {
        this.contactTouched = false;
        this.setData({
          communityId: place.communityId,
          buildingId: place.buildingId,
          houseId: place.houseId ?? null,
          communityName: place.communityName || '',
          buildingText: place.buildingText || '',
          homeText: place.addressText || '',
          roomNo: place.roomNo || '',
          contactName: me.name || '',
        });
        this.refreshPlace();
      }
    } catch {
      // 拿不到就让用户扫码
    }
  },

  /**
   * 微信扫一扫进来：先静默登录，再看有没有入驻。
   * 不强制入驻：扫了楼栋码，小区和楼栋已经确定，直接报修就行。
   */
  async enterFromScan(token: string) {
    this.setData({ booting: true, token });
    try {
      const loggedIn = await ensureOwnerLogin();
      if (!loggedIn) {
        wx.showToast({ icon: 'none', title: '登录失败，请重试' });
        return wx.reLaunch({ url: '/pages/index/index' });
      }
      const me = await auth.me().catch(() => null);
      const place = me?.place ?? null;
      if (!place || place.auditStatus === AuditStatus.REJECTED) {
        this.setData({ notOnboarded: true, phoneMatchEnabled: true });
      }
      await this.resolveToken(token);
    } finally {
      this.setData({ booting: false });
    }
  },

  /** 扫码得到的 token 换出小区/楼栋 */
  async resolveToken(token: string) {
    try {
      const info = await qr.resolve(token);
      const building = info.building
        ? `${info.building.lane ? info.building.lane + '弄' : ''}${info.building.buildingNo}号`
        : '';
      this.setData({
        token,
        communityId: info.community?.id ?? null,
        buildingId: info.building?.id ?? null,
        communityName: info.community?.name || '',
        buildingText: building,
        // 扫码只定位到楼，房号由业主自己填
        homeText: '',
      });
      this.refreshPlace();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '二维码无效，请重新扫码' });
    }
  },

  async onTapScan() {
    const token = await scanForToken();
    if (token) await this.resolveToken(token);
  },

  /** 建议去认证，但不强制 */
  onGoOnboard() {
    const token = this.data.token;
    wx.navigateTo({
      url: '/pages/onboard/onboard' + (token ? '?token=' + encodeURIComponent(token) : ''),
    });
  },

  /**
   * 微信手机号快速识别：把名下房产的地址带出来当报修位置。
   * 只带地址、不建立绑定 —— 房产档案里的电话可能是上一任业主的。
   */
  async onMatchByPhone(e: WechatMiniprogram.CustomEvent<{ code?: string }>) {
    const code = e.detail?.code;
    if (!code) {
      return this.setData({ phoneMatchMsg: '没拿到手机号授权，可以直接填房号' });
    }
    this.setData({ matching: true, phoneMatchMsg: '' });
    try {
      const resp = await auth.matchPhone({
        phoneCode: code,
        communityId: this.data.communityId ?? undefined,
      });
      if (!resp.enabled) return this.setData({ phoneMatchEnabled: false });
      if (!resp.matched || !resp.place) {
        return this.setData({
          phoneMatchMsg: resp.reason || `${resp.phone || '这个号码'}没查到房产，直接填房号就行`,
        });
      }
      const place = resp.place;
      this.setData({
        communityId: place.communityId ?? this.data.communityId,
        buildingId: place.buildingId ?? this.data.buildingId,
        houseId: place.houseId,
        roomNo: place.roomNo || this.data.roomNo,
        communityName: place.communityName || '',
        buildingText: place.buildingText || '',
        homeText: '',
        phoneMatched: true,
        phoneMatchMsg: '',
      });
      this.refreshPlace();
    } catch (err: any) {
      this.setData({ phoneMatchMsg: err?.message || '识别失败，直接填房号就行' });
    } finally {
      this.setData({ matching: false });
    }
  },

  // ---------------- 位置：self 模式的范围切换 ----------------

  onPickScope(e: WechatMiniprogram.BaseEvent) {
    const scope = e.currentTarget.dataset.scope as PlaceScope;
    if (!scope || scope === this.data.scope) return;
    this.setData({ scope, 'errors.place': '' });
    this.refreshPlace();
  },

  onPlaceDetail(e: WechatMiniprogram.Input) {
    this.setData({ placeDetail: e.detail.value });
    this.refreshPlace();
  },

  onRoom(e: WechatMiniprogram.Input) {
    // 手改门牌号后就不能再算作选中的那套房
    this.setData({ roomNo: e.detail.value, houseId: null });
    this.refreshPlace();
  },

  refreshPlace() {
    const { scope, communityName, buildingText, homeText, buildingId, placeDetail } = this.data;
    const base = {
      communityName,
      buildingText,
      // 认证房屋会带完整地址（含室号）；扫码进来的只知道到楼，就用小区·楼栋
      homeText: homeText || [communityName, buildingText].filter(Boolean).join(' '),
    };
    this.setData({
      scopes: scopeOptions(!!buildingId),
      scopeHint: scopeHint(scope),
      placeText: composePlaceText(scope, base, placeDetail),
      showSpot: isPublicScope(scope),
      // 从公共区域切回「我家里」时把已填的具体位置清掉，
      // 否则它看不见却还会拼进地址，工单上冒出一句「大门」
      ...(isPublicScope(scope) ? {} : { spotText: '' }),
    });
  },

  // ---------------- 位置：full 模式（照搬后台的三级选法） ----------------

  onPlacePicked(e: WechatMiniprogram.CustomEvent<PickedPlace>) {
    const picked = e.detail;
    this.setData({
      communityId: picked.communityId,
      communityName: picked.communityName,
      buildingId: picked.buildingId,
      buildingText: picked.buildingText,
      houseId: picked.houseId,
      roomNo: picked.roomNo,
      placeText: picked.fullText,
      showSpot: picked.isPublicArea,
      ...(picked.isPublicArea ? {} : { spotText: '' }),
      'errors.place': '',
    });
  },

  // ---------------- 具体位置 / 猜你想输 ----------------

  onSpotText(e: WechatMiniprogram.Input) {
    this.setData({ spotText: e.detail.value });
  },

  onPickSpot(e: WechatMiniprogram.BaseEvent) {
    this.setData({ spotText: String(e.currentTarget.dataset.text || '') });
  },

  onPickContentTag(e: WechatMiniprogram.BaseEvent) {
    this.setData({ content: String(e.currentTarget.dataset.text || ''), 'errors.content': '' });
  },

  // ---------------- 类型与描述 ----------------

  onPickType(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ typeIndex: index, 'errors.type': '' });
    this.refreshContentSuggestions(index);
  },

  /** 「猜你想输」跟着报修类型走，和后台一致：选了类型就给这个类型的常用说法 */
  refreshContentSuggestions(index: number) {
    const type = this.types[index];
    const keywords = (type?.keywords || []).filter(Boolean).slice(0, 8);
    this.setData({
      contentSuggestions: keywords.length ? keywords : DEFAULT_CONTENT_SUGGESTIONS,
      contentSuggestTitle: type ? `${type.label}·猜你想输` : '猜你想输',
    });
  },

  onContent(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value, 'errors.content': '' });
    this.scheduleDetect(e.detail.value);
  },

  // ---------------- 描述里的地址识别 ----------------

  /**
   * 描述里出现「一期 / 198弄 / 24号」这类片段时，让服务端拿真实楼栋房号来对。
   * 端上先用正则粗筛 + 400ms 防抖。判断口径见 utils/address-detect，
   * 新增报修入口直接引那里（随手拍 quick-repair 也是这套）。
   */
  scheduleDetect(content: string) {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    // 紧急判定挂在这里：描述框、猜你想输、语音、随手拍转过来的话，
    // 每一处改内容都会走到这一句，新增入口只要调 scheduleDetect 就自动跟上
    this.refreshUrgency(content);
    if (!shouldDetectAddress(content)) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    // 停 1.2 秒再识别（原 400ms）：打字中途每停一下就调一次大模型太浪费（2026-09-05 查费用）
    this.detectTimer = setTimeout(() => this.detectAddress(content), 1200) as unknown as number;
  },

  async detectAddress(content: string) {
    // 打字的走省钱模式：规则先撞库，撞到楼栋/房号就不调大模型
    const res = await detectRepairAddress(content, this.data.communityId ?? undefined, { lite: true });
    // 结果回来时文字可能已经变了，只认最新一次输入
    if (content !== this.data.content) return;
    if (!res) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    // 用户点过 × 的同一段地址不再弹出来
    if (res.matchedText && res.matchedText === this.dismissedMatch) return;
    const patch: Record<string, unknown> = { detected: res };
    if (this.data.typeIndex < 0 && res.ai?.repairType) {
      const index = this.types.findIndex(
        (item: PublicRepairType) => item.repairType === res.ai?.repairType,
      );
      if (index >= 0) {
        patch.typeIndex = index;
        patch.contentSuggestions = (this.types[index].keywords || []).slice(0, 8);
        patch.contentSuggestTitle = `${this.types[index].label}·猜你想输`;
      }
    }
    if (!this.data.contactName && res.ai?.contactName) patch.contactName = res.ai.contactName;
    if (!this.data.contactPhone && /^1\d{10}$/.test(res.ai?.phone || '')) {
      patch.contactPhone = res.ai?.phone;
    }
    if (res.publicArea && res.reporterRoomNo) {
      const spoken = extractContact(content);
      const spokenName = spoken.name || (res.ai?.contactName || '').trim();
      const spokenPhone = spoken.phone || (/^1\d{10}$/.test(res.ai?.phone || '') ? res.ai?.phone || '' : '');
      const roomLabel = formatReporterRoomLabel(res.buildingText, res.reporterRoomNo);
      // 公区单只采用原话明确说出的联系信息。只说一项时另一项留空，
      // 两项都没说则用当前房号做联系人标识，不与登录人默认资料混用。
      if (!this.contactTouched) patch.contactName = spokenName || roomLabel;
      if (!this.phoneTouched) {
        patch.contactPhone = spokenPhone;
        patch['errors.phone'] = '';
      }
    }
    this.setData(patch);
  },

  /** 说了「急修」就标紧急；人自己定过就不再自动改 */
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

  /** 点 × 撤掉识别结果，回到上面手选的位置 */
  onDismissDetected() {
    this.dismissedMatch = this.data.detected?.matchedText || '';
    this.setData({ detected: null });
  },

  onContactName(e: WechatMiniprogram.Input) {
    this.contactTouched = true;
    this.setData({ contactName: e.detail.value });
  },

  onPhone(e: WechatMiniprogram.Input) {
    this.phoneTouched = true;
    this.setData({ contactPhone: e.detail.value, 'errors.phone': '' });
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
      // 语音带进来的语气词先剥掉（地址留着给识别用）；追加而不是覆盖，允许说好几段
      const spoken = extractFaultDescription(text);
      const next = this.data.content ? `${this.data.content}${spoken}` : spoken;
      this.setData({ content: next, 'errors.content': '' });
      this.scheduleDetect(next);
    };
    speechManager.onError = (err: { msg?: string; retcode?: number }) => {
      hold?.ended();
      this.setData({ recording: false, partial: '' });
      // 云端识别，网差必失败：先探网络，网差就明说，别让人以为自己没说清
      speechErrorTip(err).then((title) => wx.showToast({ icon: 'none', title, duration: 3000 }));
    };
  },

  onSpeechStart() {
    // 插件的 lang 只有 zh_CN / en_US / zh_HK，没有上海话，只能按普通话识别
    // （lang 现在由 createHoldToTalk 统一传，默认就是 zh_CN）
    hold?.press();
  },

  /** touchend 和 touchcancel 都指到这里：手指滑出按钮、被来电打断也要收尾 */
  onSpeechEnd() {
    hold?.release();
  },

  // ---------------- 附件 ----------------

  async onChooseMedia() {
    if (this.data.uploading) return;
    const res = await wx
      // 显式要压缩图，别靠微信默认值
      .chooseMedia({
        count: 6,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      })
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
    const { mode, scope, communityId, typeIndex, roomNo, content, contactPhone, detected } = this.data;
    // 家里的问题不给房号就必须留电话，否则维修工既不知道去哪、也联系不上人。
    // 公共区域本来就没有房号，再要求留电话就是无谓的拦路。
    // 描述里识别到了地址时按识别的走，房号那套校验就不适用了
    const anonymousRoom = !detected?.matched && mode === 'self' && scope === 'home' && !roomNo.trim();
    const errors = {
      place: communityId || detected?.matched ? '' : '请先选择报修位置',
      type: typeIndex < 0 ? '请选择报修类型' : '',
      content: content.trim().length >= 5 ? '' : '请至少填写 5 个字描述问题',
      phone: !contactPhone
        ? anonymousRoom
          ? '不填房号时请留个电话，维修工上门前会先联系你'
          : ''
        : PHONE_RE.test(contactPhone)
          ? ''
          : '请填写正确的手机号',
    };
    this.setData({ errors });
    if (errors.place || errors.type || errors.content || errors.phone) return;

    // 描述里识别到了地址就按识别结果提交（id 和文案一起换，不能只换显示）；
    // 否则 full 模式带地址簿选的 id，self 模式按范围摘 id（公区不挂房号）
    const ids = detected?.matched
      ? {
          buildingId: detected.buildingId ?? undefined,
          houseId: detected.houseId ?? undefined,
        }
      : mode === 'full'
        ? {
            buildingId: this.data.buildingId ?? undefined,
            houseId: this.data.houseId ?? undefined,
          }
        : scopeIds(scope, this.data);

    const addressText = detected?.matched
      ? composeDetectedAddress(detected, this.data.spotText)
      : [
          this.data.placeText,
          this.data.spotText.trim(),
          // 家里的问题没填房号时明确标出来，办公室一眼知道要打电话问，而不是以为漏填了
          mode === 'self' && scope === 'home' && !roomNo.trim() && !this.data.houseId
            ? '（业主未提供房号）'
            : '',
        ]
          .filter(Boolean)
          .join(' ');

    // 订阅授权框必须由这次点击同步唤起，放到提交请求之后微信就不认了（见 utils/unread.ts）
    askSubscribeAfterSubmit();
    this.setData({ submitting: true });
    try {
      const resp = await repairs.create({
        entryMode: 'form',
        communityId: detected?.matched ? detected.communityId! : (communityId as number),
        ...ids,
        addressText,
        contactName: this.data.contactName.trim() || undefined,
        contactPhone: contactPhone || undefined,
        repairType: this.data.typeOptions[typeIndex].value,
        aiAssist: repairs.buildRepairAiAssist(content, detected),
        // 说了「急修」就按紧急提交；人点掉了就是 false —— 端上传什么服务端认什么
        urgent: this.data.urgent,
        // 地址已经单独放进 addressText，描述只留故障本身。用 matchedRaw
        // （原话里地址占的整段，含小区名）剥 —— 归一化的 matchedText 不含小区名，
        // 剥完会剩个「枫桦景苑」在描述开头。剥空就退回原文，不提交空描述。
        content: (detected?.ai?.description || '').trim() || stripAddress(content, detected?.matchedRaw),
        attachments: this.data.attachments,
      });
      wx.showToast({ title: '报修已提交' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${resp.workOrder.id}` });
      }, 600);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
