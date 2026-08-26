/**
 * 未读消息数 + 微信订阅授权。员工端只有这一份实现，页面别各写各的。
 *
 * 和业主端（apps/miniapp-owner/miniprogram/utils/unread.ts）是同一套思路，
 * 但有两处必须不一样：
 *   1. 员工端是**自定义 tabBar**，`wx.showTabBarRedDot` 对它无效 ——
 *      红点要走 tabBar 组件自己的 setBadge（挂在「我的」那一格，消息入口在那里）。
 *   2. 模板 id 按端分：员工端只有「有新工单派给你」这一个，
 *      业主端那两个模板不属于本小程序，混进来会让整个授权弹窗失败。
 */
import { auth, notifications } from '@pms/api-client';
import { setTabBadge } from './tabbar';

/**
 * 有没有登录，问 app 拿，别在这里写死 storage key ——
 * 员工端是 `pms.staff.access_token`，业主端才是 `pms.access_token`。
 * 从业主端抄代码过来时照抄了那个 key，结果这里永远判成「没登录」，
 * 消息列表和角标一直是空的，而代码看上去完全正确。
 */
function hasToken(): boolean {
  try {
    return !!getApp<{ getToken(): string | undefined }>()?.getToken();
  } catch {
    return false;
  }
}

/** 最近一次拿到的未读数，供页面直接渲染，不用每个页面各存一份 */
let lastUnread = 0;

export function getLastUnread(): number {
  return lastUnread;
}

/**
 * 拉一次未读数并更新「我的」那一格的角标。
 *
 * 小程序没有推到端的长连接，角标只能靠主动拉 —— 所有可能产生新消息的时机
 * （切回前台、进出工单页、标已读之后）都该调一次。
 * page 传当前页实例；不传就只更新缓存值，不动角标。
 */
export async function refreshUnread(page?: any): Promise<number> {
  if (!hasToken()) {
    lastUnread = 0;
    if (page) setTabBadge(page, 'me', 0);
    return 0;
  }
  try {
    const { count } = await notifications.unreadCount();
    lastUnread = count;
    if (page) setTabBadge(page, 'me', count);
    return count;
  } catch {
    // 拉不到就别乱标：宁可漏一个角标，也不要挂一个点不掉的红点
    return lastUnread;
  }
}

/**
 * 请求「有新工单派给你」的订阅授权。
 *
 * 微信的一次性订阅是「同意一次 = 能推一条」，所以要在**用户刚做完一件事**的时候补额度
 * （接单后、完工后），这时他正期待下一单，同意率最高；一进小程序就弹，
 * 多数人会下意识点拒绝，而「拒绝并不再询问」是持久的，弹错一次就再也没机会了。
 *
 * 只把用户点了「允许」的模板上报给服务端 —— 微信没有查余量的接口，
 * 服务端完全按这里记账，多报会导致「以为能推、其实推不出去」。
 *
 * @param silent true = 静默补额度（接单/完工后顺手调），失败不提示；
 *               false = 用户主动点「开启提醒」，要给明确反馈
 */
export async function askOrderSubscribe(silent = true): Promise<boolean> {
  try {
    const me = await auth.me();
    const tmplIds = (me.subscribeTemplates || []).filter(Boolean).slice(0, 3);
    // 物业还没在公众平台申请模板：静默时不弹（免得弹出一个空白授权框），
    // 用户主动点的时候要说清楚为什么没反应，别让人以为按钮坏了
    if (!tmplIds.length) {
      if (!silent) {
        wx.showModal({
          title: '还不能开启',
          content:
            '物业还没在微信公众平台申请「新工单提醒」的消息模板。请管理员在管理后台「系统设置」里填好模板 ID 后再试。',
          showCancel: false,
          confirmText: '知道了',
        });
      }
      return false;
    }

    const res = await new Promise<Record<string, string>>((resolve) => {
      wx.requestSubscribeMessage({
        tmplIds,
        success: (r) => resolve(r as unknown as Record<string, string>),
        // 用户拒绝、或没开订阅能力，都当作没授权，不打扰
        fail: () => resolve({}),
      });
    });
    const accepted = tmplIds.filter((id) => res[id] === 'accept');
    if (!accepted.length) {
      if (!silent) {
        wx.showToast({ icon: 'none', title: '没有开启，新工单只会在「消息」里提醒' });
      }
      return false;
    }
    await notifications.subscribe(accepted);
    if (!silent) wx.showToast({ title: '已开启新工单提醒' });
    return true;
  } catch {
    // 授权是锦上添花，失败绝不能影响「接单」「完工」这些主流程
    return false;
  }
}
