/**
 * 未读消息数 + 微信订阅授权。员工端只有这一份实现，页面别各写各的。
 *
 * 和业主端（apps/miniapp-owner/miniprogram/utils/unread.ts）是同一套思路，
 * 但有两处必须不一样：
 *   1. 员工端是**自定义 tabBar**，`wx.showTabBarRedDot` 对它无效 ——
 *      红点要走 tabBar 组件自己的 setBadge（挂在「我的」那一格，消息入口在那里）。
 *   2. 模板 id 按端分：员工端可有新工单、催接单、办公室催修 3 个模板；
 *      业主端模板不属于本小程序，混进来会让整个授权弹窗失败。
 */
import { notifications, repairs } from '@pms/api-client';
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
  // 顺手把订阅授权要用的东西预热好（见 primeSubscribeState）：
  // 每个页面 onShow 都会走到这里，等用户点「开启提醒」时缓存已经在了
  primeSubscribeState();
  refreshPoolBadge(page);
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
 * 工单池那一格的角标：管理处范围内有几条待接的单。
 * 工单池页自己加载完会按列表条数设一次，这里是给别的页面 onShow 时也能看到最新数 ——
 * 不然人在「我的」页收到通知切回来，角标还是上次进池子时的数。
 */
export function refreshPoolBadge(page?: any): void {
  if (!page || !hasToken()) return;
  const { pages } = readCachedAccess();
  if (pages && !pages['app:pool']) return;
  const route = String(page.route || page.__route__ || '');
  if (route.indexOf('pages/pool/') === 0) return; // 池子页自己会设，别和它抢
  repairs
    .poolCount()
    .then(({ count }) => setTabBadge(page, 'pool', count))
    .catch(() => {
      // 拉不到就保持原样
    });
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
 * 「我的」页展示用的提醒状态。
 *
 * 两个来源缺一不可：微信只能告诉我们「勾没勾总是保持以上选择」，告诉不了还剩几条；
 * 服务端只知道余量，不知道勾没勾。只看微信那一项会出现「明明每单都收到提醒，
 * 页面却写着未开启」（2026-08-28 实际反馈）—— 那个人是靠一条条点允许攒了十几条额度，
 * 没勾「总是保持」，按微信的口径确实不算「一直开着」，但按他的体感就是开着的。
 */
export interface SubscribeState {
  tmplId: string;
  /** 勾了「总是保持以上选择」：以后每次派单都会提醒 */
  always: boolean;
  /** 服务端记的余量：没勾「总是保持」时，还能提醒这么多条 */
  remaining: number;
}

export async function getSubscribeState(): Promise<SubscribeState> {
  const me = (await getSession()).me;
  const tmplId = (me?.subscribeTemplates || []).filter(Boolean)[0] || '';
  if (!tmplId) return { tmplId: '', always: false, remaining: 0 };
  const [always, state] = await Promise.all([
    isAlwaysAllowed(tmplId),
    notifications.subscribeState([tmplId]).catch(() => ({} as Record<string, number>)),
  ]);
  return { tmplId, always: always || alwaysFlag(), remaining: Number(state[tmplId] ?? 0) };
}

// ---------------------------------------------------------------------------
// 订阅授权
//
// **微信的硬规矩（基础库 2.8.2 起）：requestSubscribeMessage 必须在用户点击事件里
// 同步调用。** 点击之后只要 await 过任何异步的东西 —— 一次 wx.request、一次
// wx.getSetting、甚至一个 showModal 的回调 —— 再调它就直接 fail：
// 「requestSubscribeMessage:fail can only be invoked by user TAP gesture」，
// 微信的授权框根本不会弹出来。开发者工具不查这条，真机上才炸，所以本地看不出来。
// 2026-08-26 实际反馈「我的」页点「开启新工单提醒」没反应，就是这个：
// 原实现先 await 会话、await getSetting、再弹一个说明框，然后才调它。
//
// 所以这里的做法是：模板 id 和「勾没勾总是保持」都**提前缓存**（primeSubscribeState，
// 每次 refreshUnread 顺手做），点击时直接同步发起授权框，结果回来后再处理。
// 调用方也要遵守：在 bindtap 处理函数里**先**调 askOrderSubscribe / topUpQuietly，
// 再去 await 接单、完工这些请求 —— 放在请求之后就又踩回同一个坑。
// ---------------------------------------------------------------------------

/** 本公司给员工端配的模板 id；null = 还没拿到过 */
let cachedTmplIds: string[] | null = null;
/** 这个人是否已勾「总是保持以上选择」 */
let cachedAlways = false;

/**
 * 「总是保持以上选择」的本地旁证。
 *
 * 微信不一定把这个勾如实反映在 getSetting 的 itemSettings 里（2026-08-28：人明明勾了，
 * 页面还是按没勾显示，静默补额度也因此没跑）。但勾没勾有个可靠的旁证：勾了之后
 * requestSubscribeMessage 不弹框、几乎立刻返回 accept；没勾的话人至少要看一眼再点，
 * 几百毫秒之内不可能。所以按返回耗时记一个本地标记，判断时和 getSetting 取并集。
 */
const ALWAYS_FLAG_KEY = 'pms.staff.subscribe_always';

function alwaysFlag(): boolean {
  try { return wx.getStorageSync(ALWAYS_FLAG_KEY) === '1'; } catch { return false; }
}

function noteDialogBehaviour(tmplIds: string[], res: Record<string, string>, elapsedMs: number) {
  if (!tmplIds.some((id) => res[id] === 'accept')) return;
  try {
    if (elapsedMs < 600) {
      wx.setStorageSync(ALWAYS_FLAG_KEY, '1');
      cachedAlways = true;
    } else {
      // 弹了框才 accept：这次没勾（或者把勾取消了）。刚勾上的话，下一次静默返回会重新记上
      wx.removeStorageSync(ALWAYS_FLAG_KEY);
    }
  } catch { /* 记不下就下次再记 */ }
}

/**
 * 预热订阅授权要用的两样东西。失败保持上次的值 —— 拿不到会话不该把授权入口弄坏。
 * 走会话缓存，不会多打 /auth/me；getSetting 是本地调用。
 */
export async function primeSubscribeState(): Promise<void> {
  try {
    const me = (await getSession()).me;
    const ids = (me?.subscribeTemplates || []).filter(Boolean).slice(0, 3);
    cachedTmplIds = ids;
    cachedAlways = ids.length ? (await isAlwaysAllowed(ids[0])) || alwaysFlag() : false;
  } catch {
    // 保持上次的缓存
  }
}

interface SubscribeOutcome {
  /** 微信回的 { 模板id: 'accept' | 'reject' | 'ban' | 'filter' } */
  res: Record<string, string>;
  /** fail 时微信的原话，用来给用户/管理员看真实原因 */
  errMsg?: string;
}

/** 同步发起授权框。必须由点击事件同步调到这里，中间不能有 await */
function requestNow(tmplIds: string[]): Promise<SubscribeOutcome> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds,
      success: (r) => {
        const res = r as unknown as Record<string, string>;
        noteDialogBehaviour(tmplIds, res, Date.now() - startedAt);
        resolve({ res });
      },
      fail: (err: any) => resolve({ res: {}, errMsg: err?.errMsg || String(err || '') }),
    });
  });
}

/** 把微信的 errMsg 翻成能照着处理的话，同时保留原文便于排查 */
function explainSubscribeFailure(errMsg: string): string {
  if (/TAP gesture/i.test(errMsg)) {
    return `微信要求授权框必须由点击直接唤起，这次没赶上。请回到「我的」页再点一次「新工单微信提醒」。（微信原话：${errMsg}）`;
  }
  if (/20004|mainSwitch|主开关/i.test(errMsg)) {
    return `你把这个小程序的订阅消息总开关关掉了。请点右上角「…」→ 设置 → 订阅消息，打开后再来开启。（微信原话：${errMsg}）`;
  }
  if (/20001|20002|20003|template/i.test(errMsg)) {
    return `消息模板不对，请管理员核对管理后台「系统设置」里填的「新工单提醒」模板 ID。（微信原话：${errMsg}）`;
  }
  if (/10005|退后台|UI/i.test(errMsg)) {
    return `微信没能弹出授权框，请回到小程序再点一次。（微信原话：${errMsg}）`;
  }
  return `微信没有弹出授权框：${errMsg}`;
}

/** 处理授权结果：只把点了「允许」的模板上报，服务端按这个记额度 */
async function settle(tmplIds: string[], outcome: SubscribeOutcome, silent: boolean): Promise<boolean> {
  const accepted = tmplIds.filter((id) => outcome.res[id] === 'accept');
  if (!accepted.length) {
    if (!silent) {
      if (outcome.errMsg) {
        wx.showModal({
          title: '没有开启',
          content: explainSubscribeFailure(outcome.errMsg),
          showCancel: false,
          confirmText: '知道了',
        });
      } else {
        wx.showToast({ icon: 'none', title: '没有开启，新工单只会在「消息」里提醒' });
      }
    }
    return false;
  }
  await notifications.subscribe(accepted);
  cachedAlways = (await isAlwaysAllowed(accepted[0])) || alwaysFlag();
  if (!silent) {
    // 勾了「总是保持」= 一劳永逸；没勾 = 这次只换来一条，要说明白，
    // 否则他以为开好了，下次没收到提醒又来问一遍
    wx.showModal({
      title: cachedAlways ? '已开启' : '这次只会提醒一条',
      content: cachedAlways
        ? '以后每次派单都会在微信里提醒你。'
        : '微信规定「同意一次只能推一条」。想以后一直收到提醒，请再点一次本入口，并在弹窗里勾上左下角的「总是保持以上选择，不再询问」。',
      showCancel: false,
      confirmText: '知道了',
    });
  }
  return true;
}

/**
 * 悄悄补一次额度：**只在用户已经勾过「总是保持以上选择」时才发起**。
 *
 * 没勾过就不要调 —— 那会在他每次点开一张工单时弹一次授权框，
 * 比「没通知」还烦，而且弹多了人会点「拒绝」，一拒绝就是持久的，再也推不了。
 *
 * 挂在「点开工单卡片」这类每天都会发生很多次的点击上，额度基本能一直保持满的。
 * 只读缓存、同步发起：这里 await 任何东西都会让微信不认这次点击（见上面的说明）。
 */
/** 上次静默补额度的时刻：切 tab、点工单都会调，30 秒内只补一次，别把每次点击都变成两个请求 */
let lastTopUpAt = 0;

export function topUpQuietly(): void {
  const tmplIds = cachedTmplIds;
  if (!tmplIds?.length || !(cachedAlways || alwaysFlag())) return;
  const now = Date.now();
  if (now - lastTopUpAt < 30 * 1000) return;
  lastTopUpAt = now;
  requestNow(tmplIds)
    .then((outcome) => settle(tmplIds, outcome, true))
    .catch(() => {
      // 补额度是锦上添花，失败绝不能影响用户正在做的事
    });
}

/**
 * 请求员工端工单提醒（新工单 / 催接单 / 办公室催修）的订阅授权。
 * **必须在点击处理函数里同步调用**，
 * 放在接单/完工这些请求之后就会被微信拒绝（真机才会，开发者工具不查）。
 *
 * 微信的一次性订阅是「同意一次 = 能推一条」，所以在用户每次主动做事的点击上补额度；
 * 一进小程序就弹，多数人会下意识点拒绝，而「拒绝并不再询问」是持久的，弹错一次就再也没机会了。
 *
 * @param silent true = 顺手补额度（接单/完工的点击里调），失败不提示；
 *               false = 用户主动点「开启提醒」，要给明确反馈，包括微信的真实报错
 */
export function askOrderSubscribe(silent = true): Promise<boolean> {
  const tmplIds = cachedTmplIds;
  if (!tmplIds) {
    // 缓存还没热（页面刚打开就点了）：预热一次，让他再点一下。
    // 这里不能「await 预热完再弹」—— await 过后微信就不认这次点击了
    primeSubscribeState();
    if (!silent) wx.showToast({ icon: 'none', title: '正在准备，请再点一次' });
    return Promise.resolve(false);
  }
  if (!tmplIds.length) {
    // 物业还没在公众平台申请模板：静默时不弹（免得弹出一个空白授权框），
    // 用户主动点的时候要说清楚为什么没反应，别让人以为按钮坏了
    if (!silent) {
      wx.showModal({
        title: '还不能开启',
        content:
          '物业还没在微信公众平台申请「新工单提醒」的消息模板。请管理员在管理后台「系统设置」里填好模板 ID 后再试。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
    return Promise.resolve(false);
  }
  // 先于任何 await 同步发起授权框
  const pending = requestNow(tmplIds);
  return pending.then((outcome) => settle(tmplIds, outcome, silent)).catch(() => false);
}
