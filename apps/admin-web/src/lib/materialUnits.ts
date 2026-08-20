/**
 * 材料计量单位（antd 下拉用）。单位表本身在 @pms/shared-types，
 * 后台和员工小程序共用同一份，这里只负责拼成 antd 的分组 options。
 */
import { MATERIAL_UNIT_GROUPS, MATERIAL_UNITS } from '@pms/shared-types';

export { MATERIAL_UNIT_GROUPS, MATERIAL_UNITS };

const KNOWN_UNITS = new Set(MATERIAL_UNITS);

export function isCommonUnit(unit: string) {
  return KNOWN_UNITS.has(unit);
}

export interface UnitOptionGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

const toOptions = (units: string[]) => units.map((value) => ({ value, label: value }));

/**
 * 下拉选项 = 常用单位 + 库里已经在用但不在常用表里的单位 + 当前值（避免历史自定义单位回显空白）。
 * 老数据用过的单位一定要留着，否则编辑时会被迫改成别的单位。
 */
export function buildUnitOptions(usedUnits: string[] = [], currentValue?: string): UnitOptionGroup[] {
  const groups: UnitOptionGroup[] = MATERIAL_UNIT_GROUPS.map((group) => ({
    label: group.label,
    options: toOptions(group.units),
  }));

  const extras = Array.from(
    new Set(
      [...usedUnits, currentValue || '']
        .map((unit) => String(unit || '').trim())
        .filter((unit) => unit && !KNOWN_UNITS.has(unit)),
    ),
  );
  if (extras.length) {
    groups.push({ label: '已在用 / 自定义', options: toOptions(extras) });
  }
  return groups;
}
