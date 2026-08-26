/**
 * 冷启动自动更新到最新包。两端共用，app.ts 的 onLaunch 里调一次。
 *
 * 为什么必须有这个：微信小程序冷启动时**跑的是本地缓存包**，同时在后台异步下载新版本，
 * 要等到「下一次冷启动」才生效。所以改完发了新版，用户「关掉重新打开」看到的仍然是旧界面，
 * 得反复开关两三次、或者从「最近使用」里长按删掉才碰上新的 —— 用的人只会以为「没改」。
 * 装了 UpdateManager 之后：新包下载好就地重启，一次打开就是最新的。
 *
 * 细节：
 * - onUpdateReady 里直接 applyUpdate()，不弹确认框。这是物业内部工具，
 *   版本不一致导致的「你那边有我这边没有」比重启一下烦人得多；重启只损失当前页面的输入，
 *   而 applyUpdate 发生在启动早期，用户还没开始填东西。
 * - onUpdateFailed 只提示、不阻断：下载失败照样能用旧包干活，
 *   但要让人知道自己不是最新的，否则「我这明明是新版」的扯皮没完。
 * - 开发者工具里 canIUse 判定为 false 是正常的，直接跳过。
 */
/** 本包不引入小程序全局类型（同 speech.ts），只声明用到的这几个 API */
interface UpdateManager {
  onUpdateReady(cb: () => void): void;
  onUpdateFailed(cb: () => void): void;
  applyUpdate(): void;
}
declare const wx: {
  canIUse?(schema: string): boolean;
  getUpdateManager?(): UpdateManager | undefined;
  showModal(opts: {
    title?: string;
    content?: string;
    showCancel?: boolean;
    confirmText?: string;
  }): void;
};

export function setupAutoUpdate() {
  if (!wx.canIUse || !wx.canIUse('getUpdateManager') || !wx.getUpdateManager) return;
  let manager: UpdateManager | undefined;
  try {
    manager = wx.getUpdateManager();
  } catch {
    return;
  }
  if (!manager) return;

  manager.onUpdateReady(() => {
    // 立即重启到新包。applyUpdate 之后当前这次运行就结束了，后面的代码不会执行
    manager.applyUpdate();
  });

  manager.onUpdateFailed(() => {
    wx.showModal({
      title: '有新版本没更新成功',
      content: '你现在用的还是旧版本。把小程序从微信「最近使用」里长按删掉，再重新进一次即可。',
      showCancel: false,
      confirmText: '知道了',
    });
  });
}
