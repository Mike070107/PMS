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

// ---------------------------------------------------------------------------
// 订阅授权
//
// **微信的硬规矩（基础库 2.8.2 起）：requestSubscribeMessage 必须在用户点击事件里
// 同步调用。** 点击之后只要 await 过任何异步的东西（一次 wx.request 就够），
// 再调它就直接 fail「can only be invoked by user TAP gesture」，授权框根本不弹。
// 开发者工具不查这条，真机上才炸。原来「提交成功后再弹」的写法在真机上从来没弹出来过。
//
// 所以：模板 id 提前缓存（primeSubscribeTemplates，报修页 onLoad 调），
// 提交按钮的点击处理函数里**先**同步发起授权框，再去 await 提交请求。
// 员工端 utils/unread.ts 是同一套约定。
// ---------------------------------------------------------------------------

/** 本公司给业主端配的模板 id；null = 还没拿到过 */
let cachedTmplIds: string[] | null = null;

/** 报修页 onLoad 时预热；失败保持上次的值 */
export async function primeSubscribeTemplates(): Promise<void> {
  try {
    const me = await auth.me();
    cachedTmplIds = (me.subscribeTemplates || []).filter(Boolean).slice(0, 3);
  } catch {
    // 保持上次的缓存
  }
}

/**
 * 报修提交时请求订阅授权（已派单 / 待验收）。
 *
 * **在「提交」按钮的点击处理函数里、await 提交请求之前调**，不要等提交完 ——
 * 见上面的说明。用户刚点下提交，正期待「什么时候派单」，这时同意率本来就最高。
 *
 * 只把用户点了「允许」的模板上报给服务端 —— 服务端按这个记额度，多报会导致
 * 「以为能推、其实推不出去」。返回值不需要等，失败绝不能影响「报修已提交」这件事。
 */
export function askSubscribeAfterSubmit(): Promise<void> {
  const tmplIds = cachedTmplIds;
  if (!tmplIds) {
    // 缓存还没热就不弹了：这里不能 await 预热再弹，await 过后微信就不认这次点击
    primeSubscribeTemplates();
    return Promise.resolve();
  }
  // 物业还没在公众平台申请模板：不弹，免得弹出一个空白授权框
  if (!tmplIds.length) return Promise.resolve();

  // 先于任何 await 同步发起授权框
  const pending = new Promise<Record<string, string>>((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds,
      success: (r) => resolve(r as unknown as Record<string, string>),
      // 用户拒绝、或没开订阅能力，都当作没授权，不打扰
      fail: () => resolve({}),
    });
  });
  return pending
    .then(async (res) => {
      const accepted = tmplIds.filter((id) => res[id] === 'accept');
      if (!accepted.length) return;
      await notifications.subscribe(accepted);
    })
    .catch(() => {
      // 授权是锦上添花，失败绝不能影响「报修已提交」这件事
    });
}
