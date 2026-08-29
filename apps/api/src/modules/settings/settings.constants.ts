/**
 * 租户级开关，存在 tenant_configs（key/value jsonb）里。
 * 加新开关时：这里补一条 + 给个默认值，前后端都从这里取口径。
 */
export const TENANT_SETTING_KEYS = {
  /** 业主用微信手机号自动匹配名下房产 */
  OWNER_PHONE_AUTO_MATCH: 'owner_phone_auto_match',
  /** 微信订阅消息模板 id（业主端） */
  WX_SUBSCRIBE_TEMPLATES: 'wx_subscribe_templates',
  /** 完工后等待业主验收的时限，超时由系统自动验收 */
  AUTO_REVIEW_HOURS: 'auto_review_hours',
  /** 派单后多久没接单就升级提醒 */
  DISPATCH_ESCALATION: 'dispatch_escalation',
  /** 微信服务号（公众号）模板消息，用来给维修工发派单通知 */
  WX_SERVICE_ACCOUNT: 'wx_service_account',
} as const;

export interface OwnerPhoneAutoMatchSetting {
  /** 关闭时匹配接口直接返回未匹配，前端也不显示入口 */
  enabled: boolean;
}

/**
 * 微信订阅消息模板 id。
 * 每家物业公司自己的小程序，模板 id 各不相同，所以必须按租户配、后台能改、
 * 改完立即生效 —— 写死在环境变量里就得为一家客户重新部署一次。
 * 留空 = 该事件不推微信，只写站内信。
 */
export interface WxSubscribeTemplatesSetting {
  /** 「已派单」通知业主：师傅已接单，准备上门 */
  orderDispatched: string;
  /** 「待验收」通知业主：修好了，去看看 */
  orderReview: string;
  /**
   * 「有新工单派给你」通知**维修工**（员工端小程序）。
   * 前两个是发给业主的，这一个发给员工 —— 两个小程序的模板 id 不通用，
   * 必须在员工端小程序的公众平台后台单独申请一个再填这里。
   */
  orderAssigned: string;
  /**
   * 「超时还没人接单」催办**维修工**（员工端小程序）。
   * 和上面那条分开：新工单是「来活了」，催办是「你那单还没接」，措辞和关键词都不一样；
   * 混用同一个模板，维修工分不清哪条是新单。留空 = 退回用 orderAssigned 那个模板发。
   */
  orderOverdue: string;
  /**
   * 「催修」：办公室在工单详情里点「发送催单通知」时发给维修工，催他在要求完成截止日期前修完。
   * 和 orderOverdue 不是一回事 —— 那个催的是「没人接单」，这个催的是「接了还没修完」。
   * 留空 = 退回用 orderOverdue / orderAssigned 的模板发。
   */
  orderUrge: string;
}

export interface AutoReviewSetting {
  /** 允许 1～720 小时；默认 48 小时 */
  hours: number;
}

/**
 * 派单后迟迟没人接单时的升级提醒。
 *
 * 为什么需要它：任何一条推送都可能被漏看（微信订阅额度用完、手机静音、在忙）。
 * 与其把宝押在「通知一定送达」，不如让**漏看一条不再是终点** ——
 * 到点没接单就再催维修工一次，同时告诉办公室「这单还没人接」，办公室能兜住。
 */
export interface DispatchEscalationSetting {
  /** 总开关。关掉就完全不催 —— 以前靠 acceptMinutes=0 表达，现在有独立开关 */
  enabled: boolean;
  /** 派单（或进工单池）后多少分钟还没人接就催；允许 5～1440 */
  acceptMinutes: number;
  /**
   * 催办时段（HH:mm，服务器时区 Asia/Shanghai）。这个区间之外一条催办都不发 ——
   * 半夜把维修工震醒，第二天他会把整个提醒都关掉，比不催更糟。
   * 时段外到点的单不会被跳过，等窗口一开照样催（escalatedAt 还没打标记）。
   * 支持跨零点写法：startAt=20:00 endAt=08:00 表示只在夜里催。
   */
  startAt: string;
  endAt: string;
}

/**
 * 微信服务号（公众号）模板消息。
 *
 * 为什么要它：小程序订阅消息是「同意一次推一条」，额度用完就推不出去；
 * 服务号模板消息只要维修工**关注着**就能一直推，落在聊天列表的独立会话里，
 * 手机提醒和收到微信消息一样。这是「派单必达」唯一不花钱的路子。
 *
 * 三个前提，缺一条都推不出去（后台页面上写了操作步骤）：
 *   1. 已认证的服务号（企业主体，认证费 300 元/年）；
 *   2. 服务号和员工端小程序绑到**同一个微信开放平台账号**下 —— 只有这样
 *      小程序登录才拿得到 unionid，我们才能把「小程序里的这个维修工」
 *      和「服务号的这个粉丝」对上；
 *   3. 维修工本人关注这个服务号。
 *
 * appSecret 是密钥：只存库、只在服务端用，读接口一律脱敏，日志里绝不出现。
 */
export interface WxServiceAccountSetting {
  /** 服务号 AppID（wx 开头） */
  appId: string;
  /** 服务号 AppSecret。读出去时是脱敏预览，留空保存 = 保持不变 */
  appSecret: string;
  /** 「有新工单派给你」的模板 ID（在服务号后台「模板消息」里选一个行业模板） */
  templateOrderAssigned: string;
  /** 关掉时完全不走服务号，只走小程序订阅消息 */
  enabled: boolean;
}

export const DEFAULT_TENANT_SETTINGS: {
  ownerPhoneAutoMatch: OwnerPhoneAutoMatchSetting;
  wxSubscribeTemplates: WxSubscribeTemplatesSetting;
  autoReview: AutoReviewSetting;
  dispatchEscalation: DispatchEscalationSetting;
  wxServiceAccount: WxServiceAccountSetting;
} = {
  // 默认关：业主档案没导手机号之前开着也匹配不到，反而让业主白点一次
  ownerPhoneAutoMatch: { enabled: false },
  // 默认空：没在公众平台申请模板之前推不出去，留空就只走站内信，不报错
  wxSubscribeTemplates: {
    orderDispatched: '',
    orderReview: '',
    orderAssigned: '',
    orderOverdue: '',
    orderUrge: '',
  },
  autoReview: { hours: 48 },
  // 默认 60 分钟：比这更短会把「人正在路上还没点接单」也算成漏看，
  // 更长就失去了「当场兜住」的意义。默认只在 8:00~20:00 催，别打扰休息。后台都可改
  dispatchEscalation: { enabled: true, acceptMinutes: 60, startAt: '08:00', endAt: '20:00' },
  wxServiceAccount: { appId: '', appSecret: '', templateOrderAssigned: '', enabled: false },
};

export interface TenantSettings {
  ownerPhoneAutoMatch: OwnerPhoneAutoMatchSetting;
  wxSubscribeTemplates: WxSubscribeTemplatesSetting;
  autoReview: AutoReviewSetting;
  dispatchEscalation: DispatchEscalationSetting;
  wxServiceAccount: WxServiceAccountSetting;
}
