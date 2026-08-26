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
import { notifications } from '@pms/api-client';
import { getSession } from './session';
import { readCachedAccess, setTabBadge } from './tabbar';

/** 只读缓存判断，绝不在这里打接口：角标刷新会在各种时机被调到 */
function canSeeMessages(): boolean {
  const { pages } = readCachedAccess();
  return pages ? !!pages['app:messages'] : true;
}

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
  // 角色里没勾「消息中心」的人，「我的」页压根没有消息入口 ——
  // 这时候还挂个红点，他点进去找不到地方清，只能靠杀缓存
  if (!canSeeMessages()) {
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
 * 这个人是不是勾了「总是保持以上选择，不再询问」。
 *
 * 这是把「每次都要点允许」变成「点一次就一直提醒」的**唯一办法**：
 * 微信的长期性订阅消息只对政务、医疗、交通、金融、教育这些线下公共服务类目开放，
 * 物业类小程序申请不到。退而求其次 —— 用户在授权弹窗里勾上「总是保持以上选择」之后，
 * 后续每次 requestSubscribeMessage 都会**静默返回 accept、不再弹窗**，
 * 于是我们可以在他每一次自然点击时悄悄把额度补满，体感上就是「一直会提醒」。
 *
 * itemSettings 里有这个模板且为 accept，就说明勾过了。
 */
export function isAlwaysAllowed(tmplId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tmplId) return resolve(false);
    wx.getSetting({
      withSubscriptions: true,
      success: (res) => {
        const setting = (res as any).subscriptionsSetting || {};
        // 主开关关掉时，任何订阅都推不动，也别再去弹了
        if (setting.mainSwitch === false) return resolve(false);
        resolve((setting.itemSettings || {})[tmplId] === 'accept');
      },
      fail: () => resolve(false),
    });
  });
}

/**
 * 悄悄补一次额度：**只在用户已经勾过「总是保持以上选择」时才调**。
 *
 * 没勾过就不要调 —— 那会在他每次点开一张工单时弹一次授权框，
 * 比「没通知」还烦，而且弹多了人会点「拒绝」，一拒绝就是持久的，再也推不了。
 *
 * 必须由用户的点击行为触发（微信要求），所以挂在「点开工单卡片」这类
 * 每天都会发生很多次的动作上，额度基本能一直保持满的。
 */
export async function topUpQuietly(): Promise<void> {
  try {
    // 走会话缓存，不要再打一遍 /auth/me —— 这个函数挂在「点开工单卡片」上，
    // 每天要跑几十次，多一个请求就是几十个
    const me = (await getSession()).me;
    const tmplIds = (me?.subscribeTemplates || []).filter(Boolean).slice(0, 3);
    if (!tmplIds.length) return;
    const allowed = await isAlwaysAllowed(tmplIds[0]);
    if (!allowed) return;
    await askOrderSubscribe(true);
  } catch {
    // 补额度是锦上添花，失败绝不能影响用户正在做的事
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
    const me = (await getSession()).me;
    const tmplIds = (me?.subscribeTemplates || []).filter(Boolean).slice(0, 3);
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

    // 用户主动点「开启提醒」时，先说清楚该怎么点才能一劳永逸 ——
    // 「总是保持以上选择」这个勾选框在弹窗左下角，不说没人会去勾，
    // 不勾就退化成「同意一次只推一条」，也就是他抱怨的「每次都要点允许」
    if (!silent && !(await isAlwaysAllowed(tmplIds[0]))) {
      const tip = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '开启后就不用再点了',
          content:
            '下一步微信会弹一个授权框。请勾上左下角的「总是保持以上选择，不再询问」再点允许 —— 勾了以后每次派单都会提醒你，不用再点第二次。',
          confirmText: '知道了，去开启',
          cancelText: '取消',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!tip) return false;
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
    if (!silent) {
      const always = await isAlwaysAllowed(accepted[0]);
      // 勾了「总是保持」= 一劳永逸；没勾 = 这次只换来一条，要说明白，
      // 否则他以为开好了，下次没收到提醒又来问一遍
      wx.showModal({
        title: always ? '已开启' : '这次只会提醒一条',
        content: always
          ? '以后每次派单都会在微信里提醒你。'
          : '微信规定「同意一次只能推一条」。想以后一直收到提醒，请再点一次本入口，并在弹窗里勾上左下角的「总是保持以上选择，不再询问」。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
    return true;
  } catch {
    // 授权是锦上添花，失败绝不能影响「接单」「完工」这些主流程
    return false;
  }
}
