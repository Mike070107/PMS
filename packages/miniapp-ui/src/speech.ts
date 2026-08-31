/**
 * 语音识别失败时给用户的提示 —— 三个报修页（业主端随手拍 / 一键报修、员工端报修）共用。
 *
 * 同声传译插件是云端识别：手机只录音，音频实时传微信云端，没网或网差必失败。
 * 插件回调里的 msg 是技术文案（英文 / 错误码），老人看不懂；
 * 这里先探测一次网络状态，网差就明说「网络不稳定」，让人知道该等一等或改打字，
 * 而不是以为自己没说清楚反复重试。
 */
/** 本包不引入小程序全局类型，只声明用到的这一个 API */
declare const wx: {
  getNetworkType(opts: {
    success?: (res: { networkType: string }) => void;
    fail?: () => void;
  }): void;
};

export function speechErrorTip(err?: { msg?: string; retcode?: number } | null): Promise<string> {
  return new Promise((resolve) => {
    wx.getNetworkType({
      success: (res) => {
        const type = res.networkType;
        if (type === 'none' || type === 'unknown') {
          resolve('当前没有网络，语音识别需要联网，请检查网络或直接打字');
        } else if (type === '2g' || type === '3g') {
          resolve('网络不稳定，语音识别失败，可以直接打字或换个信号好的地方再试');
        } else {
          resolve(pickMsg(err) || '语音识别失败，可直接打字');
        }
      },
      fail: () => resolve(pickMsg(err) || '语音识别失败，可直接打字'),
    });
  });
}

/** 插件偶尔会给出可读的中文原因；英文或错误码一律不透出 */
function pickMsg(err?: { msg?: string } | null): string {
  const msg = String(err?.msg || '').trim();
  return /[一-龥]/.test(msg) ? msg : '';
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

export function createHoldToTalk(
  manager: { start(opts: { lang: string; duration: number }): void; stop(): void } | null,
  opts: { lang?: string; duration?: number } = {},
): HoldToTalk {
  let pressing = false;
  let recording = false;
  return {
    press() {
      if (!manager || recording) return;
      pressing = true;
      manager.start({ lang: opts.lang || 'zh_CN', duration: opts.duration ?? 30000 });
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
