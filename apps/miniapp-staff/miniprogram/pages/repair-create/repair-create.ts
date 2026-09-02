import { auth, repairs, upload } from '@pms/api-client';
import type {
  ParsedRepairAddress,
  PublicRepairType,
} from '@pms/api-client/src/endpoints/repairs';
import {
  classifyRepairType,
  contactFillHint,
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  detectUrgency,
  extractContact,
  extractFaultDescription,
  formatReporterRoomLabel,
  isVideoUrl,
  MAX_REPAIR_IMAGES,
  MAX_REPAIR_VIDEO_SECONDS,
  MAX_REPAIR_VIDEOS,
  mergeExtractedContact,
  REPAIR_TYPE_OPTIONS,
  urgencyReason,
} from '@pms/shared-types';
import {
  shouldDetectAddress,
  composeDetectedAddress,
  detectRepairAddress,
} from '../../utils/address-detect';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import { loadAddressBook } from '../../utils/address-picker';

/**
 * 提交前把描述里的地址剥掉。地址已经单独放进 addressText，描述只该留故障本身。
 *
 * 传 matchedRaw（地址在原话里占的整段，含小区名），不要传归一化的 matchedText ——
 * 那份不含小区名，剥完描述里会剩个「枫桦景苑」（2026-08-31 用户实际看到的）。
 * 剥空了就退回原文：宁可描述里带点地址，也不能提交一条空描述。
 */
function stripAddress(content: string, matchedRaw?: string | null): string {
  const full = content.trim();
  if (!matchedRaw) return full;
  const stripped = extractFaultDescription(full, { addressText: matchedRaw }).trim();
  return stripped || full;
}

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

    /**
     * 描述里说了「急修 / 加急 / 抢修」→ 这单按紧急处理（判定见 shared-types 的
     * detectUrgency，随手拍走的是同一份）。认出来才显示那一行，点一下取消、再点标回来。
     */
    urgent: false,
    urgentMatched: '',
    urgentReasonText: '',

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
  /** 联系人/电话当前是 loadMe 填的默认值（登录人）——描述里认出别人时可以顶掉 */
  contactIsDefault: false,
  phoneIsDefault: false,
  phoneTouched: false,
  /** 公区报修已经按原话处理过联系人后，不允许异步 loadMe 再把登录人默认值补回来 */
  suppressContactDefaults: false,
  /** 当前角色可见小区；null = 全公司，空数组 = 一个小区都没授权 */
  reportCommunityIds: null as number[] | null,
  /** 地址簿缓存必须带登录人和范围，避免同一台手机切账号后看到上个人的数据 */
  addressCacheScope: 'staff:unknown',
  detectTimer: 0 as number,
  /** 人自己点过「紧急」那一行之后，就别再被自动判定覆盖 */
  urgentTouched: false,
  /** 随手拍转过来的原话。它和「问题描述」框里的文字不是同一份，识别守卫要认它 */
  handoffRaw: '' as string,
  dismissedMatch: '' as string,

  /**
   * q.content / q.attachments：从「随手拍」转过来的。
   * 那边已经说过一遍话、拍过照了，转到完整表单只是为了逐项改，
   * 不能让人从头再来一次。
   */
  onLoad(q: Record<string, string>) {
    this.bindSpeech();
    this.loadTypes();
    const handoff = decodeURIComponent(q?.content || '').trim();
    // 随手拍那边剥干净的描述进「问题描述」框，原话只用来做识别 ——
    // 剥过的话里已经没有联系人和电话了，拿它去抽只会抽出个空
    const rawSpeech = decodeURIComponent(q?.raw || '').trim();
    this.handoffRaw = rawSpeech;
    const media = decodeURIComponent(q?.attachments || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (media.length) this.setAttachments(media);
    if (handoff) {
      this.setData({ content: handoff });
      // 有原话就用原话认（地址/联系人/电话/类型都在里面），没有就退回描述本身
      this.scheduleDetect(rawSpeech || handoff);
    }
    // 地址簿范围取决于身份（代报角色只能报授权小区），所以先 me() 再拉地址簿，
    // 别并行 —— 并行的话保安会先看到全公司地址簿，选完提交才被后端拦下
    this.loadMe().then(() => this.loadBook());
  },

  onUnload() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
  },

  /**
   * 不再由端上逐个小区拼地址簿：后台根据当前业务角色的数据范围统一收窄，
   * 管理处角色只能拿到该管理处的小区；空范围就返回空集。
   */
  async loadBook() {
    try {
      const scope = this.reportCommunityIds;
      const book = scope === null
        ? await loadAddressBook(undefined, this.addressCacheScope)
        : scope.length
          ? Array.from(
              new Map(
                (await Promise.all(
                  scope.map((id) => loadAddressBook(id, this.addressCacheScope).catch(() => [])),
                ))
                  .flat()
                  // 兼容后台尚未更新时「选一个分期顺带返回同组其它分期」的旧行为，
                  // 端上仍按角色的精确范围做最后一道过滤和去重。
                  .filter((item) => scope.includes(item.id))
                  .map((item) => [item.id, item] as const),
              ).values(),
            )
          : [];
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
      // 从随手拍带描述进来时，首次识别跑在词表加载完之前，判不出类型；这里补判一次
      if (this.data.content) this.autoFillFromText(this.data.content);
    } catch {
      // 拉不到就用内置类型，别挡住报修
    }
  },

  /** 联系人默认本人：系统已知的直接预填，允许改。顺带取回角色的数据范围 */
  async loadMe() {
    try {
      const me = await auth.me();
      const grants = me.reporter?.communities || [];
      const accessScope = me.access?.scopeAll === false
        ? (me.access.communityIds ?? [])
        : null;
      // reporter 是旧代报授权口径；员工统一角色上线后以 access 为准。
      // 保留前者兼容尚未迁完的账号，但绝不把空数组解释成全公司。
      this.reportCommunityIds = grants.length
        ? grants.map((c) => c.id)
        : accessScope;
      this.addressCacheScope = `staff:${me.id}:${
        this.reportCommunityIds === null ? 'all' : this.reportCommunityIds.join(',') || 'none'
      }`;
      // 只填还空着的：描述里已经认出的人（「张先生报，电话138…」）比登录人更准，不能被盖掉
      const patch: Record<string, string> = {};
      if (!this.suppressContactDefaults && !this.data.contactName && !this.contactTouched && me.name) {
        patch.contactName = me.name;
        this.contactIsDefault = true;
      }
      if (!this.suppressContactDefaults && !this.data.contactPhone && !this.phoneTouched && me.phone) {
        patch.contactPhone = me.phone;
        this.phoneIsDefault = true;
      }
      this.setData({
        ...patch,
        scopeHint: grants.length
          ? `你可报修的范围：${grants.map((c) => c.name).join('、')}`
          : this.reportCommunityIds === null
            ? ''
            : this.reportCommunityIds.length
              ? `当前按${(me.access?.offices || []).map((o) => o.name).join('、') || '业务角色范围'}显示`
              : '当前业务角色还没有配置可报修的小区，请联系管理员',
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
   * 3. 认不出就保持空白，不瞎猜；
   * 4. 电话被描述里的号码顶掉、这句话又没说是谁时，默认联系人（登录人）一起清空 ——
   *    号码换人了，那个名字就一定不对，留着会拼出「张保安 + 业主的号」的假联系人。
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
    // 合并规则（空着的/默认值可被顶掉、手改过的不动、电话换人则清空默认联系人）
    // 统一在 shared-types 的 mergeExtractedContact 里，别在页面里再写一套
    const merged = mergeExtractedContact(extractContact(text), {
      name: this.data.contactName,
      phone: this.data.contactPhone,
      nameIsDefault: this.contactIsDefault,
      phoneIsDefault: this.phoneIsDefault,
      nameTouched: this.contactTouched,
      phoneTouched: this.phoneTouched,
    });
    this.contactIsDefault = merged.nameIsDefault;
    this.phoneIsDefault = merged.phoneIsDefault;
    const patch: Record<string, string> = {};
    if (merged.name !== undefined) patch.contactName = merged.name;
    if (merged.phone !== undefined) {
      patch.contactPhone = merged.phone;
      patch['errors.phone'] = '';
    }
    const hint = contactFillHint(merged);
    if (hint) patch.autoContactHint = hint;
    if (Object.keys(patch).length) this.setData(patch);
  },

  scheduleDetect(content: string) {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    // 类型/联系人/电话/紧急都不受地址关键词限制，任何一次输入都跟着识别。
    // 描述框、猜你想输、语音、随手拍转过来的话都走到这里，新增入口只要调它就自动跟上
    this.autoFillFromText(content);
    this.refreshUrgency(content);
    if (!shouldDetectAddress(content)) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    this.detectTimer = setTimeout(() => this.detectAddress(content), 400) as unknown as number;
  },

  async detectAddress(content: string) {
    const res = await detectRepairAddress(content, this.data.communityId ?? undefined);
    // 结果回来时文字可能已经变了，只认最新一次输入。
    // 随手拍转过来的原话是个例外：它本来就和描述框里的文字不同（描述已剥掉地址），
    // 不放行的话地址识别结果会被这条守卫直接丢掉
    if (content !== this.data.content && content !== this.handoffRaw) return;
    if (!res) {
      if (this.data.detected) this.setData({ detected: null });
      return;
    }
    if (res.matchedText && res.matchedText === this.dismissedMatch) return;
    const patch: Record<string, unknown> = { detected: res };
    const aiType = res.ai?.repairType;
    if (aiType && !this.typePickedByUser) {
      const local = classifyRepairType(content, this.types);
      const lower = content.toLowerCase();
      const explicit = !!local?.matched.some((word) => lower.includes(word.toLowerCase()));
      const index = this.types.findIndex((item) => item.repairType === aiType);
      if ((res.ai?.sampleMatched || !explicit) && index >= 0) {
        this.predictedType = aiType;
        patch.typeIndex = index;
        patch.autoTypeHint = res.ai?.sampleMatched
          ? '已采用后台确认过的识别样例，可手动修改'
          : 'AI 按设备场景识别，可手动修改';
        patch.contentSuggestions = (this.types[index].keywords || []).slice(0, 8);
        patch.contentSuggestTitle = `${this.types[index].label}·猜你想输`;
      }
    }
    if (res.publicArea && res.reporterRoomNo) {
      /**
       * 公区单里的房号表示“哪一户报的”，不是维修地点。联系人只认原话明确说出的值：
       * 两项都说就都填；只说一项就把另一项登录人默认值清掉；都没说就用房号作姓名、电话留空。
       */
      this.suppressContactDefaults = true;
      const spoken = extractContact(content);
      const spokenName = spoken.name || (res.ai?.contactName || '').trim();
      const spokenPhone = spoken.phone || (/^1\d{10}$/.test(res.ai?.phone || '') ? res.ai?.phone || '' : '');
      const roomLabel = formatReporterRoomLabel(res.buildingText, res.reporterRoomNo);
      if (!this.contactTouched) {
        patch.contactName = spokenName || roomLabel;
        this.contactIsDefault = false;
      }
      if (!this.phoneTouched) {
        patch.contactPhone = spokenPhone;
        patch['errors.phone'] = '';
        this.phoneIsDefault = false;
      }
      patch.autoContactHint = spokenName || spokenPhone
        ? '已按原话填写联系人信息；没说的项目已清空，避免混用登录人资料'
        : `公共区域报修未留联系人，已用房号 ${roomLabel} 作为联系人标识`;
    } else {
      if (!this.data.contactName && res.ai?.contactName) patch.contactName = res.ai.contactName;
      if (!this.data.contactPhone && /^1\d{10}$/.test(res.ai?.phone || '')) {
        patch.contactPhone = res.ai?.phone;
      }
    }
    this.setData(patch);
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
      // 联系人和电话由下面的字段单独接住（autoFillFromText），说的这一段里就别再留着；
      // 语气词一并剥掉。地址先留在文字里 —— 识别要靠它撞库，提交时再从描述里去掉
      const contact = extractContact(text);
      const spoken = extractFaultDescription(text, {
        phoneText: contact.phoneText,
        nameText: contact.nameText,
      });
      // 追加而不是覆盖，允许说好几段；认联系人要用原话（剥过的里面已经没有电话了）
      const next = this.data.content ? this.data.content + spoken : spoken;
      this.setData({ content: next, 'errors.content': '' });
      this.autoFillFromText(text);
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
    hold?.press();
  },

  /** touchend 和 touchcancel 都指到这里：手指滑出按钮、被来电打断也要收尾 */
  onSpeechEnd() {
    hold?.release();
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
        // 图片显式要压缩图（不写就是微信默认值，机型不同可能给原图）；
        // 视频不受 sizeType 影响，靠上面的 maxDuration 限时长
        sizeType: ['compressed'],
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
      place: communityId || detected?.matched ? '' : '请先选择报修位置',
      type: typeIndex < 0 ? '请选择报修类型' : '',
      content: content.trim().length >= 5 ? '' : '请至少填写 5 个字描述问题',
      phone: contactPhone && !PHONE_RE.test(contactPhone) ? '请填写正确的手机号' : '',
    };
    this.setData({ errors });
    if (errors.place || errors.type || errors.content || errors.phone) return;

    // 描述里识别到了地址就按识别结果提交（id 和文案一起换）；否则用地址簿选的
    const ids = detected?.matched
      ? { buildingId: detected.buildingId ?? undefined, houseId: detected.houseId ?? undefined }
      : { buildingId: this.data.buildingId ?? undefined, houseId: this.data.houseId ?? undefined };
    const addressText = detected?.matched
      ? composeDetectedAddress(detected, this.data.spotText)
      : [this.data.placeText, this.data.spotText.trim()].filter(Boolean).join(' ');

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
        // 把「系统当初判的是什么」一并带上：和最终选的不一致时，
        // 后端记一条负样本，下次这个词就不会再往错的类型上撞
        predictedRepairType: this.predictedType || undefined,
        aiAssist: repairs.buildRepairAiAssist(this.handoffRaw || content, detected),
        // 说了「急修」就按紧急提交；人点掉了就是 false —— 端上传什么服务端认什么
        urgent: this.data.urgent,
        // 地址在描述里留到这一刻是为了让识别撞库（见 onSpeech 那段注释），
        // 提交时剥掉：地址已经单独放在 addressText 里了，描述只留故障本身。
        // 用 matchedRaw（原话里的那一整段，含小区名），不是归一化的 matchedText ——
        // 后者剥完会剩个「枫桦景苑」在描述开头（2026-08-31 实际现象）。
        // 剥空了就退回原文：宁可带点地址，也不能提交一条空描述
        content: (detected?.ai?.description || '').trim() || stripAddress(content, detected?.matchedRaw),
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
