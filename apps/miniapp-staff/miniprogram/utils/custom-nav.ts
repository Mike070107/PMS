/**
 * 自定义导航栏（navigationStyle: custom 的页面）要和微信胶囊按钮对齐、给它让位。
 *
 * 2026-09-04 模拟器截图发现：语音报修 / 工单现场处理 / 填表报修三页导航栏右侧的「?」
 * 正好压在胶囊（… ◎）下面，点不到；只给右侧加 padding 又会让副标题换行、标题被顶进状态栏。
 * 胶囊是微信画在页面之上的，位置只能问 wx，所以：
 *   · 标题行的顶边 = 胶囊顶边、高度 = 胶囊高度，返回箭头、标题、「?」都在这一行；
 *   · 标题行 padding-right 按胶囊左沿算，标题和「?」都待在胶囊左边；
 *   · 副标题单独一行放在标题行下面，占满整宽，不会被胶囊压住也不用换行。
 * 拿不到胶囊位置（极少数机型）时全部返回 0，页面沿用 wxss 里的默认高度。
 *
 * 用法：onLoad 里 this.setData({ nav: customNavLayout() })；
 *   <view class="xx-nav__safe" style="{{nav.top ? 'height:' + nav.top + 'px' : ''}}"></view>
 *   <view class="xx-nav__bar" style="padding-right:{{nav.padRight}}px;{{nav.height ? 'min-height:' + nav.height + 'px' : ''}}">
 */
export interface CustomNavLayout {
  /** 标题行右侧留白（px） */
  padRight: number;
  /** 胶囊顶边距屏幕顶（px），0 = 未知 */
  top: number;
  /** 胶囊高度（px），0 = 未知 */
  height: number;
}

export function customNavLayout(): CustomNavLayout {
  const none: CustomNavLayout = { padRight: 0, top: 0, height: 0 };
  try {
    const rect = wx.getMenuButtonBoundingClientRect();
    const { windowWidth } = wx.getWindowInfo();
    if (!rect || !rect.width || !rect.height || !windowWidth) return none;
    return {
      // 胶囊左沿到屏幕右沿，再留 8px 呼吸
      padRight: Math.max(0, Math.round(windowWidth - rect.left + 8)),
      top: Math.round(rect.top),
      height: Math.round(rect.height),
    };
  } catch {
    return none;
  }
}
