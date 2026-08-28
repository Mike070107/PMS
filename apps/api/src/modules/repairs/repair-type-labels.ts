/**
 * 报修类型编码 → 中文名。工单列表、报表都要把 `water` 翻成「水相关」，
 * 租户自建类型（menjing、duijiang…）的中文只在 repair_type_rules 里有，
 * 所以统一走 resolveRepairTypeLabel(code, tenantLabels)：租户配置优先，
 * 再回退内置类型表和旧编码表。新增需要显示类型名的地方直接引这里。
 */
export const DEFAULT_REPAIR_TYPES = [
  { repairType: 'water', label: '水相关' },
  { repairType: 'electric', label: '电相关' },
  { repairType: 'door_window', label: '家里门锁/门窗相关' },
  { repairType: 'appliance', label: '家电/设备相关' },
  { repairType: 'elevator', label: '电梯相关' },
  { repairType: 'smart', label: '智能化相关' },
  { repairType: 'public', label: '公共设施相关' },
  { repairType: 'other', label: '其它' },
];

/** 旧类型编码 → 新类型编码/标准名（存量租户懒迁移用） */
export const LEGACY_REPAIR_TYPE_MAP: Record<string, { repairType: string; label: string }> = {
  plumbing: { repairType: 'water', label: '水相关' },
  electric: { repairType: 'electric', label: '电相关' },
  lock: { repairType: 'door_window', label: '家里门锁/门窗相关' },
  elevator: { repairType: 'elevator', label: '电梯相关' },
  appliance: { repairType: 'appliance', label: '家电/设备相关' },
  public: { repairType: 'public', label: '公共设施相关' },
  other: { repairType: 'other', label: '其它' },
};

export function resolveRepairTypeLabel(
  repairType: string | null | undefined,
  tenantLabels: Map<string, string>,
): string {
  if (!repairType) return '其它';
  return (
    tenantLabels.get(repairType) ||
    DEFAULT_REPAIR_TYPES.find((item) => item.repairType === repairType)?.label ||
    LEGACY_REPAIR_TYPE_MAP[repairType]?.label ||
    repairType
  );
}
