// 物业费（账单 / 收费标准）的枚举与文案。与 apps/api/src/common/enums.ts 同源，改动需双向同步。
//
// 设计边界（2026-08-26 定）：这一页只做「记账」—— 账单生成、登记收款、欠费查询、
// 老系统历史账目导入。不接微信支付、不算滞纳金、不开电子发票，那些是单独立项的事
// （见 docs/roadmap-phase2.md「物业费缴纳」）。

/** 账单状态 */
export enum FeeBillStatus {
  /** 未缴 */
  UNPAID = 'unpaid',
  /** 已缴 */
  PAID = 'paid',
  /** 已退款（老系统有退款记录的账单原样保留） */
  REFUNDED = 'refunded',
  /** 已作废（误生成 / 免收，不计入应收） */
  CANCELLED = 'cancelled',
}

export const FEE_BILL_STATUS_LABELS: Record<string, string> = {
  [FeeBillStatus.UNPAID]: '未缴',
  [FeeBillStatus.PAID]: '已缴',
  [FeeBillStatus.REFUNDED]: '已退款',
  [FeeBillStatus.CANCELLED]: '已作废',
};

/** 账单来源 */
export enum FeeBillSource {
  LEGACY_IMPORT = 'legacy_import',
  GENERATED = 'generated',
  MANUAL = 'manual',
}

export const FEE_BILL_SOURCE_LABELS: Record<string, string> = {
  [FeeBillSource.LEGACY_IMPORT]: '老系统导入',
  [FeeBillSource.GENERATED]: '按标准生成',
  [FeeBillSource.MANUAL]: '手工录入',
};

/** 收费标准状态 */
export enum FeeStandardStatus {
  ACTIVE = 'active',
  HISTORY = 'history',
}

export const FEE_STANDARD_STATUS_LABELS: Record<string, string> = {
  [FeeStandardStatus.ACTIVE]: '当前生效',
  [FeeStandardStatus.HISTORY]: '历史',
};

/**
 * 费用项目预置表：code 存库、name 随单快照。老系统的 15 个收费项目全部覆盖，
 * 新公司不够用时加一行；**已上线的 code 不要改**（账单/标准按它筛选）。
 */
export const FEE_ITEMS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'management', name: '物业管理费' },
  { code: 'rent', name: '租金' },
  { code: 'clean_guard', name: '保洁保安费' },
  { code: 'guard', name: '保安费' },
  { code: 'clean', name: '保洁费' },
  { code: 'parking', name: '泊位费' },
  { code: 'temp_parking', name: '临时停车费' },
  { code: 'network', name: '网络费' },
  { code: 'water', name: '水费' },
  { code: 'electricity', name: '电费' },
  { code: 'locker', name: '快递柜费' },
  { code: 'vacant_rent', name: '空房租金' },
  { code: 'other', name: '其他' },
];

export const FEE_ITEM_LABELS: Record<string, string> = FEE_ITEMS.reduce(
  (acc, item) => ({ ...acc, [item.code]: item.name }),
  {} as Record<string, string>,
);

/** 收款方式：与前台收费页共用同一套 value，老系统的「支票 / 贷记凭证」也在里面 */
export const FEE_PAYMENT_METHODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'cash', label: '现金' },
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
  { value: 'bank', label: '银行转账 / 贷记凭证' },
  { value: 'cheque', label: '支票' },
  { value: 'other', label: '其他' },
];

export const FEE_PAYMENT_METHOD_LABELS: Record<string, string> = FEE_PAYMENT_METHODS.reduce(
  (acc, item) => ({ ...acc, [item.value]: item.label }),
  {} as Record<string, string>,
);

/** 账期 '202207' → '2022-07'；非法值原样返回 */
export function formatFeePeriod(period?: string | null): string {
  if (!period) return '-';
  const m = /^(\d{4})(\d{2})$/.exec(period);
  return m ? `${m[1]}-${m[2]}` : period;
}

/** 分 → '¥1,234.50' */
export function formatFeeMoney(cents?: number | null): string {
  const yuan = (cents || 0) / 100;
  return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
