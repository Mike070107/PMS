import { BadRequestException } from '@nestjs/common';
import { FEE_ITEMS } from '../../common/enums';

export interface TemplateItem {
  feeCode: string;
  unitPriceCents: number;
  unit: string;
  calculation: 'fixed' | 'quantity' | 'area';
  cycle: 'month' | 'once';
  originalStandardCents?: number | null;
}
export type TemplateOverrides = Record<string, number>;

export function normalizeTemplateItems(input: unknown): TemplateItem[] {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new BadRequestException('模板需包含1—20个收费项目');
  const seen = new Set<string>();
  return input.map((row) => {
    if (!row || typeof row !== 'object' || !FEE_ITEMS.some(item => item.code === row.feeCode)) throw new BadRequestException('收费项目无效');
    if (seen.has(row.feeCode)) throw new BadRequestException('同一模板不能重复添加收费项目');
    seen.add(row.feeCode);
    if (!Number.isSafeInteger(row.unitPriceCents) || row.unitPriceCents < 0 || row.unitPriceCents > 100000000) throw new BadRequestException('单价必须是0—100万元之间的整数分');
    if (!['fixed','quantity','area'].includes(row.calculation) || !['month','once'].includes(row.cycle)) throw new BadRequestException('计费方式或周期无效');
    if (typeof row.unit !== 'string' || !row.unit.trim() || row.unit.length > 12) throw new BadRequestException('请填写计费单位');
    if (row.originalStandardCents != null && (!Number.isSafeInteger(row.originalStandardCents) || row.originalStandardCents < 0)) throw new BadRequestException('原始标准无效');
    return { feeCode:row.feeCode, unitPriceCents:row.unitPriceCents, unit:row.unit.trim(), calculation:row.calculation, cycle:row.cycle,
      ...(row.originalStandardCents !== undefined ? {originalStandardCents:row.originalStandardCents} : {}) };
  });
}

export function normalizeOverrides(input: unknown, items: TemplateItem[]): TemplateOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('住户个别调整格式无效');
  const result: TemplateOverrides = {};
  for (const [code,value] of Object.entries(input)) {
    if (!items.some(item => item.feeCode === code)) throw new BadRequestException(`个别调整项目 ${code} 不在当前模板中，请明确清除旧调整后再更换模板`);
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100000000) throw new BadRequestException('个别单价必须是有效整数分');
    result[code] = value as number;
  }
  return result;
}

export function resolveTemplateItems(items: TemplateItem[], overrides: TemplateOverrides, area: string | number | null) {
  const checked = normalizeOverrides(overrides,items);
  return items.map(item => {
    const unitPriceCents = checked[item.feeCode] ?? item.unitPriceCents;
    if (item.calculation === 'area' && (area == null || !Number.isFinite(Number(area)) || Number(area) <= 0)) throw new BadRequestException('该房间缺少有效建筑面积，不能按面积计算收费');
    const amountCents = item.calculation === 'area' ? Math.round(unitPriceCents * Number(area)) : unitPriceCents;
    if (!Number.isSafeInteger(amountCents) || amountCents > 2147483647) throw new BadRequestException('计算金额超出支持范围');
    return {...item,unitPriceCents,amountCents,isOverride:Object.hasOwn(checked,item.feeCode)};
  });
}

export function standardSignature(items: TemplateItem[]) {
  return JSON.stringify([...items].sort((a,b) => a.feeCode.localeCompare(b.feeCode)));
}
