/** 智能化维修工的工种编码，与员工档案「智能化相关」选项一致。 */
export const SMART_REPAIR_SKILL = 'smart';

/** 线上仓库允许名称里有空格，比较前先收紧；优先认产品约定的完整名称。 */
function compactWarehouseName(name: string) {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function hasSmartRepairSkill(skills?: string[] | null) {
  return !!skills?.includes(SMART_REPAIR_SKILL);
}

export function findSmartRepairWarehouse<T extends { name: string; enabled?: boolean }>(
  warehouses: T[],
): T | null {
  const enabled = warehouses.filter((item) => item.enabled !== false);
  const exact = enabled.find(
    (item) => compactWarehouseName(item.name) === '智能化维修工仓库',
  );
  if (exact) return exact;
  // 兼容已经建成「XX智能化维修工仓库」的存量名称，但不把普通管理处仓误认进来。
  return enabled.find((item) => {
    const name = compactWarehouseName(item.name);
    return name.includes('智能化') && name.includes('维修') && name.includes('仓');
  }) ?? null;
}
