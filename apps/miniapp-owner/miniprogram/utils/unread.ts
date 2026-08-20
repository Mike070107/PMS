import { auth, notifications } from '@pms/api-client';

/**
 * 未读红点。
 *
 * 红点打在 tabBar 的「我的」上（消息入口在那一页）。用 showRedDot 而不是数字角标：
 * 老人看数字要辨认，看到红点知道「有新东西」就够了，也避免 99+ 这种没意义的数字。
 *
 * 所有会产生新消息的动作（提交报修、进详情页、切回前台）之后都该调一次 ——
 * 小程序没有推送到端的长连接，红点只能靠主动拉。
 */
const ME_TAB_INDEX = 2;

export async function refreshUnreadBadge(): Promise<number> {
  if (!wx.getStorageSync('pms.access_token')) {
    wx.hideTabBarRedDot({ index: ME_TAB_INDEX, fail: () => {} });
    return 0;
  }
  try {
    const { count } = await notifications.unreadCount();
    if (count > 0) {
      wx.showTabBarRedDot({ index: ME_TAB_INDEX, fail: () => {} });
    } else {
      wx.hideTabBarRedDot({ index: ME_TAB_INDEX, fail: () => {} });
    }
    return count;
  } catch {
    // 拉不到就别乱标：宁可漏一个红点，也不要一直挂着一个点不掉的红点
    return 0;
  }
}

/**
 * 提交报修后请求订阅授权。
 *
 * 时机很关键：必须在**用户刚做完一件事**的时候弹，这时他期待后续通知，
 * 同意率最高；一进小程序就弹，多数人会下意识点拒绝，而微信的「拒绝并不再询问」
 * 是持久的，弹错一次就再也没机会了。
 *
 * 只把用户点了「允许」的模板上报给服务端 —— 服务端按这个记额度，多报会导致
 * 「以为能推、其实推不出去」。
 */
export async function askSubscribeAfterSubmit(): Promise<void> {
  try {
    const me = await auth.me();
    const tmplIds = (me.subscribeTemplates || []).filter(Boolean).slice(0, 3);
    // 物业还没在公众平台申请模板：不弹，免得弹出一个空白授权框
    if (!tmplIds.length) return;

    const res = await new Promise<Record<string, string>>((resolve) => {
      wx.requestSubscribeMessage({
        tmplIds,
        success: (r) => resolve(r as unknown as Record<string, string>),
        // 用户拒绝、或没开订阅能力，都当作没授权，不打扰
        fail: () => resolve({}),
      });
    });
    const accepted = tmplIds.filter((id) => res[id] === 'accept');
    if (!accepted.length) return;
    await notifications.subscribe(accepted);
  } catch {
    // 授权是锦上添花，失败绝不能影响「报修已提交」这件事
  }
}
