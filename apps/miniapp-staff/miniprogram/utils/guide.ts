/**
 * 「指导层」开关：说明文字默认收起，只留要填的、要点的；点右上角「?」再展开。
 *
 * 2026-09-04 Mike 反馈：页面说明太多，用户不知道点哪里，对老年人不友好。设计定下的规矩
 * （设计画布 2026-09-04 定稿：claude.ai/code/artifact/f1e05cf8-241e-415c-88a1-354d81625365）：
 *   · 导航副标题、卡片副标题、按钮下那行小字、示例句、步骤说明 → 全部归指导层，默认不显示；
 *   · 保留三种东西：数据、要填的框、要点的按钮；「必填 / 选填」两个字的小标保留；
 *   · 权限不够的黄色 .notice、错误提示、空态文案不算说明，照常显示。
 *   · 例外：「我的」页每个菜单项下那一行说明**始终显示**，不归指导层 —— 2026-09-06 Mike：
 *     「一会一个版本有，一会一个版本又没有」，其实是换版本清了缓存又默认展开、点过 ? 又收起；
 *     入口的一句话介绍本来就该常驻，别再挂 wx:if="{{guide}}"。
 *
 * 一个开关全端通用（storage），不按页面各记一份 —— 人要的是「别再教我」，不是逐页关。
 * 第一次登录默认打开一次，点过「知道了，收起」之后就一直收起。
 *
 * 用法：
 *   Page({ data: { guide: false }, ...guideHandlers(), onShow() { this.syncGuide(); } })
 *   <view class="nav-help {{guide ? 'nav-help--on' : ''}}" bindtap="onToggleGuide">?</view>
 *   <view wx:if="{{guide}}" class="tip">…说明…</view>
 */
const GUIDE_KEY = 'pms.staff.guide';

/** 读开关：没记过 = 第一次用，先开着 */
export function readGuide(): boolean {
  try {
    const raw = wx.getStorageSync(GUIDE_KEY);
    return raw === '' || raw === undefined ? true : raw === '1';
  } catch {
    return false;
  }
}

export function writeGuide(on: boolean): void {
  try {
    wx.setStorageSync(GUIDE_KEY, on ? '1' : '0');
  } catch {
    /* 存不下就只影响这一次 */
  }
}

/** 混进 Page() 的三个方法；页面 data 里要有 guide 字段 */
export function guideHandlers() {
  return {
    /** onShow 里调：别的页面切了开关，回到这一页要跟着变 */
    syncGuide(this: any) {
      const guide = readGuide();
      if (this.data.guide !== guide) this.setData({ guide });
    },
    onToggleGuide(this: any) {
      const guide = !this.data.guide;
      writeGuide(guide);
      this.setData({ guide });
    },
    /** 指导条上的「知道了，收起」 */
    onDismissGuide(this: any) {
      writeGuide(false);
      this.setData({ guide: false });
    },
  };
}
