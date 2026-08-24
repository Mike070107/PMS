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
