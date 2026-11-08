/**
 * 微信提醒额度快用完时的现场提示（工单池 / 在手工单共用）。
 *
 * 为什么需要它：微信的一次性订阅是「同意一次只能推一条」，额度扣完以后
 * 派单只会落站内信，微信里一声不响 —— 人只会觉得「今天怎么没提醒」，
 * 要自己进「我的」才发现状态变成了「未开启」（见 utils/unread.ts 的说明）。
 *
 * 为什么不是「额度用完自动弹框」：微信规定 requestSubscribeMessage 必须由
 * 真实点击同步唤起（基础库 2.8.2 起），onShow / 定时器 / 接口回调里调用
 * 只会 fail `can only be invoked by user TAP gesture`。所以只能等人打开小程序、
 * 落到这一屏，先把提示摆在那里，由他**点一下**再把授权框叫起来。
 *
 * 用法：
 *   Page({
 *     data: { notifyPrompt: false, notifyRemaining: 0, notifyRenewing: false },
 *     ...notifyPromptHandlers(),
 *     async load() { ...; this.checkNotifyPrompt(有接单权); }
 *   })
 *   <import src="/templates/notify-banner.wxml"/>
 *   <template is="notify-banner" data="{{notifyPrompt: notifyPrompt, notifyRemaining: notifyRemaining, notifyRenewing: notifyRenewing}}"/>
 */
import { askOrderSubscribe, getSubscribeState } from './unread';

/** 剩几条开始提示：0 条已经收不到了，1～2 条是最后的补额机会 */
const LOW_WATER = 2;
/** 当天点过「知道了」或刚补成功：今天不再打扰，明天再提醒 */
const HIDE_KEY = 'pms.staff.notify_prompt_hidden';

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function hiddenToday(): boolean {
  try {
    return wx.getStorageSync(HIDE_KEY) === todayKey();
  } catch {
    return false;
  }
}

function hideToday(): void {
  try {
    wx.setStorageSync(HIDE_KEY, todayKey());
  } catch {
    // 存不下就只是明天之前还会再提示一次，不影响功能
  }
}

export function notifyPromptHandlers() {
  return {
    /**
     * 查一次额度，决定要不要在页头摆那条提示。
     *
     * @param canPrompt 这个人有没有「新工单提醒」这回事 —— 维修工才有，
     *                  口径和「我的」页 canSubscribe 一致（session.canAccept）。
     */
    checkNotifyPrompt(this: any, canPrompt: boolean) {
      if (!canPrompt) {
        if (this.data.notifyPrompt) this.setData({ notifyPrompt: false });
        return;
      }
      if (hiddenToday()) return;
      // 状态本身带 60 秒缓存（utils/unread.ts），补过额度会 invalidate，
      // 所以这里不用再压一层节流：切档、搜索最多就是读一次缓存
      getSubscribeState()
        .then((state) => {
          if (!state.tmplId) return;
          // 勾了「总是保持」的人走的是静默补额（每次点击 +1），不该再被问一次；
          // 只看没勾的人 —— 他们的额度用完是真的收不到
          const low = !state.always && state.remaining <= LOW_WATER;
          // 同一个结果不重复 setData：这一句在切档、搜索时都会被调到
          if (low === this.data.notifyPrompt && state.remaining === this.data.notifyRemaining) return;
          this.setData({ notifyPrompt: low, notifyRemaining: state.remaining });
        })
        .catch(() => {
          // 查不到就维持现状：宁可少一条提示，也不要在页头挂一条点不掉的警告
        });
    },

    /**
     * 点「重新开启」：授权框必须在这一下点击里同步唤起。
     * 所以 askOrderSubscribe 必须第一个调，前面不能有 await（见 utils/unread.ts）。
     */
    onRenewNotify(this: any) {
      if (this.data.notifyRenewing) return;
      const pending = askOrderSubscribe(false);
      this.setData({ notifyRenewing: true });
      pending
        .then((ok: boolean) => {
          if (!ok) return null;
          // 刚同意过：当天不再提示，避免「刚开完又催一次」
          hideToday();
          // 余量以服务端为准，强制重查一次（settle 已经 invalidate 过缓存）
          return getSubscribeState(true);
        })
        .then((state) => {
          if (!state) return;
          this.setData({ notifyRemaining: state.remaining, notifyPrompt: false });
        })
        .catch(() => {})
        .then(() => this.setData({ notifyRenewing: false }));
    },

    onDismissNotify(this: any) {
      hideToday();
      this.setData({ notifyPrompt: false });
    },
  };
}
