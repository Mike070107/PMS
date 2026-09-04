import { maskPhone } from '@pms/miniapp-ui';
import { buildStampText } from '../../utils/buildStamp';
import { USER_ROLE_LABELS, type MeResp } from '@pms/shared-types';
import { clearSession, getSession } from '../../utils/session';
import { cachedMeMode, clearAccessCache, rememberPoolMode, syncTabBar } from '../../utils/tabbar';
import { askOrderSubscribe, getSubscribeState } from '../../utils/unread';
import { refreshTabBadges } from '../../utils/badges';
import { openFeedback } from '../../utils/feedback';
import { repairExperiences } from '@pms/api-client';
import { guideHandlers } from '../../utils/guide';

// 版本号和 git hash 由发版脚本写入 utils/buildStamp.ts，别在这里手改（见那个文件的说明）

/** 传给工单池那一屏：进去切到「我报的」那一档。tabBar 页 switchTab 不能带参数 */
const OPEN_REPORTED_KEY = 'pms.staff.open_reported';
/** 传给登录页：这次是人主动退出的，别再静默登回来 */
const JUST_LOGGED_OUT_KEY = 'pms.staff.just_logged_out';

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    mode: 'me' as 'me' | 'more',
    buildText: '',
    user: null as MeResp | null,
    roleText: '',
    phoneText: '',
    /** 头像用姓名首字，没名字就用角色首字 */
    avatarText: '',
    canReport: false,
    canSeeMyRepairs: false,
    canUseMessages: true,
    /** 未读消息数，显示在「消息」入口右侧 */
    unread: 0,
    /** 维修工才有「新工单提醒」这回事 —— 单是派给他的 */
    canSubscribe: false,
    /**
     * always = 勾了「总是保持以上选择」，每次派单都会提醒；
     * banked = 没勾，但服务端还记着几条额度，用完就收不到了；
     * off    = 一条额度都没有。
     * 文案在 refreshNotifyState 里一次算好，wxml 只负责渲染
     */
    notifyState: 'off' as 'off' | 'banked' | 'always',
    notifyRemaining: 0,
    notifyTone: '' as '' | 'on' | 'partial',
    notifyStateText: '未开启',
    notifyDesc: '点这里开启；弹窗里记得勾上「总是保持以上选择」',
    /** 代报角色：报修范围是授权小区，不是全公司，文案得说准 */
    repairDesc: '巡查发现的问题直接提单，地址可选全公司任意楼栋房号',
    experienceAccess: { canView: false, canEdit: false, notebookCount: 0 },
  },

  /** 显示当前跑的是哪个包：改完重新上传后，忘记「选为体验版本」一眼就能看出来 */
  showBuild() {
    try {
      const info = wx.getAccountInfoSync().miniProgram;
      const envText = { develop: '开发版', trial: '体验版', release: '正式版' }[info.envVersion] || info.envVersion;
      this.setData({ buildText: [envText, info.version || buildStampText()].filter(Boolean).join(' ') });
    } catch {
      this.setData({ buildText: '' });
    }
  },

  onShow() {
    this.syncGuide();
    this.applyMode();
    this.showBuild();
    this.load();
    // 未读数每次进来都重新拉：小程序没有推到端的长连接，角标只能主动拿
    // 底部几格的角标一起对准；返回值是未读数，这一页要显示它
    refreshTabBadges(this).then((unread) => this.setData({ unread }));
  },

  async load() {
    // “更多”和“我的”共用一个原生 tab 页；同页切换不一定触发 onShow，
    // custom-tab-bar 会直接调用 load，所以这里也必须重新读模式。
    this.applyMode();
    try {
      // 身份和权限都从这一份会话来（utils/session.ts），页面里不再各写角色白名单
      const [session, experienceAccess] = await Promise.all([
        getSession(this, true),
        repairExperiences.access().catch(() => ({ canView: false, canEdit: false, notebookCount: 0 })),
      ]);
      const user = session.me as MeResp;
      // 显示他绑的角色名 —— 现在没有「身份」这回事，角色名就是他的称呼
      const roleText = session.roleNames.join(' · ') || USER_ROLE_LABELS[user.role] || '员工';
      const reporterOnly = session.reporterOnly;
      // 授权小区在 me().reporter 里，报修范围就照它写 —— 写成「全公司」会让保安
      // 选到没授权的小区，提交时才被后端拦下（assertCanReportAt），白填一遍
      const scope = (user.reporter?.communities || []).map((c) => c.name).join('、');
      this.setData({
        user,
        roleText,
        phoneText: maskPhone(user.phone),
        avatarText: (user.name || roleText || '员').trim().charAt(0),
        canReport: session.canReport,
        canSeeMyRepairs: session.canSeeMyRepairs,
        canUseMessages: session.canUseMessages,
        canSubscribe: session.canAccept,
        repairDesc: reporterOnly
          ? (scope ? `可报 ${scope} 内任意楼栋房号` : '还没有可代报的小区，请联系物业管理员开通')
          : '巡查发现的问题直接提单，地址可选全公司任意楼栋房号',
        experienceAccess,
      });
      if (session.canAccept) this.refreshNotifyState();
    } catch {
      // 未登录时由请求层跳转登录页
    }
  },

  applyMode() {
    const mode = cachedMeMode();
    this.setData({ mode });
    syncTabBar(this, mode);
    wx.setNavigationBarTitle({ title: mode === 'more' ? '更多' : '我的' });
  },

  onOpenExperience() {
    if (!this.data.experienceAccess.canView) {
      wx.showToast({ icon: 'none', title: '暂无可查看的类别笔记本' });
      return;
    }
    wx.navigateTo({ url: '/pages/experience-notes/experience-notes' });
  },

  onGoRepair() {
    wx.navigateTo({ url: '/pages/repair-create/repair-create' });
  },

  /**
   * 「我的报修」= 工单池那一屏的「我报的」档（2026-08-31 从「在手工单」搬过去的）。
   *
   * 不另做一个列表页：同一批单两处各查一次、各渲染一套，迟早对不上（口径、状态文案、
   * 卡片样式）。这里只负责把人送过去并切到那一档 —— tabBar 页 switchTab 不能带参数，
   * 所以用一次性标记传话（pool 的 onShow 读完就清）。
   * 顺手把「工单池 / 派单台」的模式定成工单池：两格都有权限的人（维修组长）
   * 上次停在派单台的话，那一屏没有这三档，标记会白写。
   */
  onOpenReported() {
    try { wx.setStorageSync(OPEN_REPORTED_KEY, '1'); } catch { /* 存不下就只是没自动切档 */ }
    rememberPoolMode('pool');
    wx.switchTab({ url: '/pages/pool/pool' });
  },

  onOpenMessages() {
    wx.navigateTo({ url: '/pages/messages/messages' });
  },

  onFeedback() {
    void openFeedback();
  },

  onOpenFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' });
  },

  /** 用户主动点「开启新工单提醒」：要给明确反馈，不能静默失败 */
  async onEnableNotify() {
    await askOrderSubscribe(false);
    await this.refreshNotifyState();
  },

  /**
   * 「开启新工单提醒」这一项显示的是当前状态，不是一个动作按钮 ——
   * 已经勾过「总是保持」的人再看到「开启提醒」会以为没生效，又点一遍。
   */
  async refreshNotifyState() {
    const state = await getSubscribeState();
    const notifyState = state.always ? 'always' : state.remaining > 0 ? 'banked' : 'off';
    // 勾了「总是保持」也要把剩余条数显出来（2026-08-31 反馈「怎么不显示剩余条数了」）：
    // 「已开启」是靠**每次点击悄悄补额度**换来的，不是微信给了长期权限 ——
    // 额度照样一条条扣。不显示的话，万一补额度那条路断了，人只会看到一个「已开启」
    // 却收不到提醒，谁都查不出问题出在哪。
    this.setData({
      notifyState,
      notifyRemaining: state.remaining,
      notifyTone: notifyState === 'always' ? 'on' : notifyState === 'banked' ? 'partial' : '',
      notifyStateText:
        notifyState === 'always'
          ? `已开启 · 剩 ${state.remaining} 条`
          : notifyState === 'banked'
            ? `还能提醒 ${state.remaining} 条`
            : '未开启',
      notifyDesc:
        notifyState === 'always'
          ? '每次派单微信都会提醒你。你在小程序里切底部页签、点开工单时会自动补额度，不用再点允许'
          : notifyState === 'banked'
            ? '每收一条提醒少一条，用完就收不到了。点这里再开一次，并勾上「总是保持以上选择」，以后就会自动补'
            : '点这里开启；弹窗里记得勾上「总是保持以上选择」',
    });
  },

  async onLogout() {
    const res = await wx.showModal({
      title: '退出登录',
      content: '退出后需重新验证身份，微信绑定不会解除',
    });
    if (!res.confirm) return;
    getApp<{ clearTokens: () => void }>().clearTokens();
    // 身份、权限、会话缓存都要清掉：换个人登进来，tabBar 和各页面不该还按上一个人的权限渲染
    clearAccessCache();
    clearSession();
    /**
     * 关键的一步：告诉登录页「这次是人主动退出的，别再静默登回来」。
     *
     * 登录页 onLoad 会拿 wx.login 的 code 直接换 token（微信 openid 早就绑好了），
     * 所以清掉 token 跳过去之后，它一进页面就又把人登了进来、switchTab 回工单池 ——
     * 屏幕上一闪，看起来就是「点了退出没反应，退不出去」（2026-08-31 反馈）。
     * 想换个手机号登录的人更是被锁死在原账号里。
     */
    try { wx.setStorageSync(JUST_LOGGED_OUT_KEY, '1'); } catch { /* 存不下最多是又静默登回去 */ }
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
