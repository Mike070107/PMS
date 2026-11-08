/** MIS 收费分类的唯一映射：SQL 只产出 code，展示名统一由这里转中文。 */
export type MisFeeCategory = 'property' | 'berth' | 'parking' | 'other';

export const MIS_FEE_CATEGORY_LABELS: Record<MisFeeCategory, string> = {
  property: '物业费',
  berth: '泊位费',
  parking: '停车',
  other: '其他',
};

export function misFeeCategoryLabel(code: unknown): string {
  return MIS_FEE_CATEGORY_LABELS[String(code) as MisFeeCategory] || MIS_FEE_CATEGORY_LABELS.other;
}

export function isMisFeeCategory(value: unknown): value is MisFeeCategory {
  return value === 'property' || value === 'berth' || value === 'parking' || value === 'other';
}

/** 兼容只拿到中文/历史名称的旧数据，反推分类 code。 */
export function misFeeCategoryOfText(value: unknown): MisFeeCategory {
  const text = String(value ?? '');
  if (/物业|管理费/.test(text) && !/停车/.test(text)) return 'property';
  if (/泊位/.test(text)) return 'berth';
  if (/停车|车位/.test(text)) return 'parking';
  return 'other';
}

/**
 * 分类表达式。MIS 直连（SQL Server）用 N'' 前缀，PostgreSQL 镜像不用。
 * 先物业、再泊位、再停车/车位，顺序与现有口径一致；输出 code，不输出中文。
 */
export function misFeeCategorySql(column: string, opts: { nPrefix?: boolean } = {}) {
  const q = (value: string) => opts.nPrefix ? `N'${value}'` : `'${value}'`;
  return `CASE WHEN ${column} LIKE ${q('%物业%')} OR (${column} LIKE ${q('%管理费%')} AND ${column} NOT LIKE ${q('%停车%')}) THEN 'property' WHEN ${column} LIKE ${q('%泊位%')} THEN 'berth' WHEN ${column} LIKE ${q('%停车%')} OR ${column} LIKE ${q('%车位%')} THEN 'parking' ELSE 'other' END`;
}
