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
}

export interface AutoReviewSetting {
  /** 允许 1～720 小时；默认 48 小时 */
  hours: number;
}

export const DEFAULT_TENANT_SETTINGS: {
  ownerPhoneAutoMatch: OwnerPhoneAutoMatchSetting;
  wxSubscribeTemplates: WxSubscribeTemplatesSetting;
  autoReview: AutoReviewSetting;
} = {
  // 默认关：业主档案没导手机号之前开着也匹配不到，反而让业主白点一次
  ownerPhoneAutoMatch: { enabled: false },
  // 默认空：没在公众平台申请模板之前推不出去，留空就只走站内信，不报错
  wxSubscribeTemplates: { orderDispatched: '', orderReview: '' },
  autoReview: { hours: 48 },
};

export interface TenantSettings {
  ownerPhoneAutoMatch: OwnerPhoneAutoMatchSetting;
  wxSubscribeTemplates: WxSubscribeTemplatesSetting;
  autoReview: AutoReviewSetting;
}
