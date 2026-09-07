/**
 * 语音识别失败时给用户的提示 —— 三个报修页（业主端随手拍 / 一键报修、员工端报修）共用。
 *
 * 同声传译插件是云端识别：手机只录音，音频实时传微信云端，没网或网差必失败。
 * 插件回调里的 msg 是技术文案（英文 / 错误码），老人看不懂；
 * 这里先探测一次网络状态，网差就明说「网络不稳定」，让人知道该等一等或改打字，
 * 而不是以为自己没说清楚反复重试。
 */
/** 本包不引入小程序全局类型，只声明用到的这几个 API；带 ? 的在老基础库里可能不存在 */
declare const wx: {
  getNetworkType(opts: {
    success?: (res: { networkType: string }) => void;
    fail?: () => void;
  }): void;
  getSetting(opts: {
    success?: (res: { authSetting: Record<string, boolean | undefined> }) => void;
    fail?: () => void;
  }): void;
  authorize(opts: { scope: string; success?: () => void; fail?: (err?: { errMsg?: string }) => void }): void;
  openSetting(opts?: { success?: () => void; fail?: () => void }): void;
  showToast(opts: { title: string; icon?: string; duration?: number }): void;
  showModal(opts: {
    title?: string;
    content?: string;
    confirmText?: string;
    cancelText?: string;
    showCancel?: boolean;
    success?: (res: { confirm: boolean }) => void;
  }): void;
  getPrivacySetting?(opts: {
    success?: (res: { needAuthorization: boolean; privacyContractName?: string }) => void;
    fail?: () => void;
  }): void;
  requirePrivacyAuthorize?(opts: {
    success?: () => void;
    fail?: (err?: { errMsg?: string; errno?: number }) => void;
  }): void;
};

/**
 * 插件 onError 的错误码 → 人话。文档里的原文是给开发者看的（「录音接口出错」），
 * 用户要的是「我该怎么办」。没列出来的码走通用文案。
 * 码表来自微信开放文档「同声传译」插件页。
 */
const RETCODE_TIPS: Record<number, string> = {
  [-30001]: '录音没能开始：请确认已允许微信和本小程序使用麦克风（手机设置 → 微信 → 麦克风），再按住说话',
  [-30002]: '录音被中断了，请再按住说一次',
  [-30003]: '没收到录音：请检查麦克风权限，或换个安静点的地方再试',
  [-30004]: '识别结果没取回来，多半是网络不稳，稍后再试或直接打字',
  [-30005]: '识别服务暂时出错，稍后再试或直接打字',
  [-30006]: '识别超时了，说短一点、说完就松手',
  [-30008]: '网络不稳，识别结果没取回来，稍后再试或直接打字',
  [-30009]: '识别服务暂时连不上，稍后再试或直接打字',
  [-30010]: '网络不稳，识别服务连不上，稍后再试或直接打字',
  [-30011]: '上一段还在识别，稍等一下再按',
  [-40001]: '语音识别太频繁了，歇几秒再试',
};

export function speechErrorTip(err?: { msg?: string; retcode?: number } | null): Promise<string> {
  return new Promise((resolve) => {
    const known = pickMsg(err);
    wx.getNetworkType({
      success: (res) => {
        const type = res.networkType;
        if (type === 'none' || type === 'unknown') {
          resolve('当前没有网络，语音识别需要联网，请检查网络或直接打字');
        } else if (type === '2g' || type === '3g') {
          resolve('网络不稳定，语音识别失败，可以直接打字或换个信号好的地方再试');
        } else {
          resolve(known || '语音识别失败，可直接打字');
        }
      },
      fail: () => resolve(known || '语音识别失败，可直接打字'),
    });
  });
}

/** 先按错误码给人话；插件偶尔给的可读中文原因也用；英文原文一律不透出 */
function pickMsg(err?: { msg?: string; retcode?: number } | null): string {
  const msg = String(err?.msg || '').trim();
  if (/privacy/i.test(msg)) {
    return '还没同意本小程序的隐私保护指引，语音要用到麦克风；同意后再按住说话，或直接打字';
  }
  const code = Number(err?.retcode);
  if (Number.isFinite(code) && RETCODE_TIPS[code]) return RETCODE_TIPS[code];
  return /[一-龥]/.test(msg) ? msg : '';
}

type PermissionState = 'ok' | 'privacy-declined' | 'privacy-undeclared' | 'record-denied' | 'unknown';

/**
 * 录音前把两道门先敲开：隐私保护指引 → 麦克风权限。
 *
 * 2026-09-07 Mike：新用户按住说话只弹一句「语音识别失败」，**连麦克风授权框都没出来**。
 * 录音是隐私接口，用户没点过「同意隐私保护指引」时平台直接拦下；这一拦发生在插件内部，
 * 平台的隐私弹窗又不一定替插件弹，于是新用户什么都看不到就失败了，老用户早年点过所以没事。
 * 这里由小程序自己先调 requirePrivacyAuthorize（弹隐私协议）和 authorize scope.record（弹麦克风框），
 * 都过了再让插件 start。第二次以后 ok 会被记住，不再多走这一趟。
 */
function ensureRecordPermission(): Promise<PermissionState> {
  return new Promise((resolve) => {
    const askRecord = () => {
      wx.getSetting({
        success: (res) => {
          const granted = res.authSetting?.['scope.record'];
          if (granted === true) {
            resolve('ok');
            return;
          }
          if (granted === false) {
            // 以前拒绝过：微信不会再弹框，只能去设置页打开
            resolve('record-denied');
            return;
          }
          wx.authorize({
            scope: 'scope.record',
            success: () => resolve('ok'),
            fail: () => resolve('record-denied'),
          });
        },
        fail: () => resolve('unknown'),
      });
    };
    if (typeof wx.getPrivacySetting !== 'function' || typeof wx.requirePrivacyAuthorize !== 'function') {
      askRecord();
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        if (!res.needAuthorization) {
          askRecord();
          return;
        }
        wx.requirePrivacyAuthorize!({
          success: askRecord,
          fail: (err) => {
            // errno 112：小程序后台的「用户隐私保护指引」里根本没声明这一项 —— 是配置问题，不是用户没点
            const text = String(err?.errMsg || '');
            resolve(err?.errno === 112 || /not declared/i.test(text) ? 'privacy-undeclared' : 'privacy-declined');
          },
        });
      },
      fail: askRecord,
    });
  });
}

/** 权限没过时怎么跟用户说：各页面不用再各写一套 */
function explainPermission(state: PermissionState): void {
  if (state === 'record-denied') {
    wx.showModal({
      title: '需要麦克风权限',
      content: '语音报修要用麦克风。请在设置里允许本小程序使用麦克风，回来再按住说话；或者直接打字。',
      confirmText: '去设置',
      cancelText: '先打字',
      success: (res) => {
        if (res.confirm) wx.openSetting({});
      },
    });
    return;
  }
  if (state === 'privacy-undeclared') {
    wx.showModal({
      title: '语音功能还没开通',
      content:
        '小程序后台的「用户隐私保护指引」里还没声明麦克风（录音）用途，微信不允许录音。请管理员在公众平台补上；现在可以直接打字。',
      showCancel: false,
      confirmText: '知道了',
    });
    return;
  }
  if (state === 'privacy-declined') {
    wx.showToast({ title: '需要先同意隐私保护指引才能用语音；不同意可以直接打字', icon: 'none', duration: 3000 });
    return;
  }
  wx.showToast({ title: '暂时无法开始录音，请直接打字', icon: 'none' });
}

/**
 * 「按住说话」的按压状态机 —— 四个报修入口共用（两端 × 随手拍/填表报修）。
 *
 * 解决的是**首次授权那一下**（2026-08-31 用户实测报的）：
 * 第一次按住时微信会弹麦克风授权框，用户为了点「允许」手指必然离开按钮，
 * 这一下的 touchend 落在弹框上、页面根本收不到；而插件的 onStart 要等授权通过
 * 才回调，那时才把 recording 置 true —— 于是按钮永远停在「松开结束」，
 * 看着像「点一下就开始录」，用户就真去点第二下。
 * 第二次因为已授权、start 立刻回调，touchend 正常收到，反而好的，
 * 所以这个毛病只在首次出现，很容易被当成偶发放过去。
 *
 * 做法：不依赖 touchend 一定能收到，自己记住手指是否还按着；
 * onStart 回来时发现手指早松了，就替它补一次 stop，把按钮还原成「按住说话」。
 *
 * 2026-09-07 又加一层：第一次按下先把隐私协议和麦克风权限敲开（见 ensureRecordPermission），
 * 弹框期间手指必然松开，所以权限过了也**不自动开始录**，提示「再按住说一次」；
 * 之后每次按下直接 start。
 *
 * 用法（页面里）：
 *   const hold = createHoldToTalk(speechManager);
 *   speechManager.onStart = () => { this.setData({ recording: true }); hold.started(); };
 *   speechManager.onStop  = () => { hold.ended(); … };
 *   speechManager.onError = () => { hold.ended(); … };
 *   onStartRecord() { hold.press(); },
 *   onStopRecord()  { hold.release(); },   // touchend 和 touchcancel 都要绑这个
 *
 * 插件实例由页面传进来：requirePlugin 只能在小程序上下文里调，本包拿不到。
 */
export interface HoldToTalk {
  /** bindtouchstart */
  press(): void;
  /** bindtouchend / bindtouchcancel */
  release(): void;
  /** 插件 onStart 回调里调 */
  started(): void;
  /** 插件 onStop / onError 回调里调 */
  ended(): void;
}

/** 权限过一次就记住（整个小程序生命周期内），别每次按住都去问一遍 */
let recordPermissionReady = false;

export function createHoldToTalk(
  manager: { start(opts: { lang: string; duration: number }): void; stop(): void } | null,
  opts: { lang?: string; duration?: number } = {},
): HoldToTalk {
  let pressing = false;
  let recording = false;
  let checking = false;
  const start = () => {
    if (!manager) return;
    manager.start({ lang: opts.lang || 'zh_CN', duration: opts.duration ?? 30000 });
  };
  return {
    press() {
      if (!manager || recording || checking) return;
      pressing = true;
      if (recordPermissionReady) {
        start();
        return;
      }
      checking = true;
      ensureRecordPermission().then((state) => {
        checking = false;
        if (state !== 'ok') {
          pressing = false;
          explainPermission(state);
          return;
        }
        recordPermissionReady = true;
        if (pressing) {
          // 权限本来就有、只是第一次走这段：手还按着就直接开始
          start();
        } else {
          // 弹过框、手已经松开：不偷偷开始录，让人再按一次
          wx.showToast({ title: '可以了，请再按住说话', icon: 'none' });
        }
      });
    },
    release() {
      pressing = false;
      /* 还没真正开始录（授权框还开着、或 start 尚未回调）时去 stop，插件会报错，
         所以这里只放行「已经在录」的情况；另一种情况交给 started() 收尾。 */
      if (!manager || !recording) return;
      manager.stop();
    },
    started() {
      recording = true;
      // 走到这儿还发现手指早松了 = 授权框吃掉了 touchend，替它补一次
      if (!pressing && manager) manager.stop();
    },
    ended() {
      recording = false;
      pressing = false;
    },
  };
}
