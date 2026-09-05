/**
 * 自定义导航栏页面的「返回」：点左上角箭头，或从屏幕左边缘往右滑。
 *
 * 为什么不能只写 wx.navigateBack()：从订阅消息 / 通知点进来的工单详情，页面栈里只有它
 * 这一页，navigateBack 无处可回、静默失败，人就卡在那一页（2026-09-04 反馈）。
 * 微信原生导航栏在这种情况下会自己变成「返回首页」，自定义导航栏得自己兜底。
 *
 * 边缘滑动：iOS 微信对小程序页面自带右滑返回；Android 没有。所以在页面根节点接
 * touch 事件自己判：起点贴左边缘、横向滑够、竖向没怎么动 → 返回。
 *
 * 用法（自定义导航的页面都这么接，别各写各的）：
 *   Page({ ...swipeBackHandlers(), onBack() { this.onEdgeBack(); }, onEdgeBack() { … } })
 *   <view class="page"
 *     bindtouchstart="onSwipeBackStart" bindtouchmove="onSwipeBackMove"
 *     bindtouchend="onSwipeBackEnd" bindtouchcancel="onSwipeBackCancel">
 *
 * **按层退，不是按页退**（2026-09-05 反馈）：工单详情 → 记录用料面板 → 材料库弹层，
 * 这时右滑只该收掉材料库；再滑收面板；再滑才退页面。所以手势结束时先问页面有没有
 * onEdgeBack —— 页面自己知道叠了几层弹层，先收最上面那层；一层都没开才 goBack()。
 * 只有「完工提交成功」这类业务动作才直接跳回列表页，那是业务代码自己 navigateBack 的。
 */
import { readCachedAccess } from './tabbar';

/** 页面栈退无可退时落到哪一格：先在手工单，其次工单池，什么都没有就「我的」 */
function homeUrl(): string {
  const { pages } = readCachedAccess();
  if (!pages) return '/pages/pool/pool';
  if (pages['app:my-orders']) return '/pages/my-orders/my-orders';
  if (pages['app:pool'] || pages['app:dispatch'] || pages['app:my-repairs']) return '/pages/pool/pool';
  return '/pages/me/me';
}

function goHome() {
  const url = homeUrl();
  wx.switchTab({ url, fail: () => wx.reLaunch({ url }) });
}

/** 有上一页就回上一页；没有（从通知直接打开的）就回到该去的 tab 页 */
export function goBack(): void {
  if (getCurrentPages().length > 1) {
    wx.navigateBack({ fail: () => goHome() });
    return;
  }
  goHome();
}

/** 起点离左边缘多近才算「从边缘滑」（px） */
const EDGE_PX = 28;
/** 横向至少滑这么远才触发（px），太短会和普通拖动混淆 */
const TRIGGER_PX = 90;
/** 竖向漂移超过这个就当作在上下滚动，不再当返回手势（px） */
const MAX_DRIFT_PX = 70;

interface SwipeState {
  x: number;
  y: number;
  live: boolean;
}

/** 混进 Page() 的四个 touch 处理器；根节点绑上对应事件即可 */
export function swipeBackHandlers() {
  return {
    onSwipeBackStart(this: any, e: WechatMiniprogram.TouchEvent) {
      const t = e.touches?.[0];
      this.__swipeBack = t && t.clientX <= EDGE_PX
        ? ({ x: t.clientX, y: t.clientY, live: true } as SwipeState)
        : null;
    },
    onSwipeBackMove(this: any, e: WechatMiniprogram.TouchEvent) {
      const s: SwipeState | null = this.__swipeBack;
      if (!s || !s.live) return;
      const t = e.touches?.[0];
      if (t && Math.abs(t.clientY - s.y) > MAX_DRIFT_PX) s.live = false;
    },
    onSwipeBackEnd(this: any, e: WechatMiniprogram.TouchEvent) {
      const s: SwipeState | null = this.__swipeBack;
      this.__swipeBack = null;
      if (!s || !s.live) return;
      const t = e.changedTouches?.[0];
      if (!t) return;
      if (t.clientX - s.x < TRIGGER_PX || Math.abs(t.clientY - s.y) > MAX_DRIFT_PX) return;
      // iOS 自带的右滑返回可能已经把这一页弹掉了：这时再退一次会多退一页
      const pages = getCurrentPages();
      if (pages[pages.length - 1] !== this) return;
      // 页面定义了 onEdgeBack 就按层退（先收弹层），否则直接退页面
      if (typeof this.onEdgeBack === 'function') this.onEdgeBack();
      else goBack();
    },
    onSwipeBackCancel(this: any) {
      this.__swipeBack = null;
    },
  };
}
