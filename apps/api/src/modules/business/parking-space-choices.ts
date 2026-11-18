import { BadRequestException } from '@nestjs/common';

export interface ParkingSpaceChoice { id: number; garage: string; spaceNo: string; unavailableReason: string }
/** 按库隔离、自然排序、重复编号不可选；不以绑定车牌判断占用（一位可关联多车）。 */
export function parkingSpaceChoices(spaces: Array<{ id: number; garage: string; spaceNo: string }>): ParkingSpaceChoice[] {
  const counts = new Map<string, number>();
  const key = (s: { garage: string; spaceNo: string }) => `${s.garage}\0${s.spaceNo}`;
  spaces.forEach(s => counts.set(key(s), (counts.get(key(s)) || 0) + 1));
  return [...spaces].sort((a, b) => a.garage.localeCompare(b.garage) || a.spaceNo.localeCompare(b.spaceNo, 'zh-CN', { numeric: true }))
    .map(s => ({ id: s.id, garage: s.garage, spaceNo: s.spaceNo, unavailableReason: counts.get(key(s))! > 1 ? '车位号重复，请先核对档案' : '' }));
}
export function validateSelectedSpaces(selected: unknown, numbers: unknown, choices: ParkingSpaceChoice[]) {
  if (!Array.isArray(selected) || selected.some(g => !['phase1', 'phase2', 'main', 'civil'].includes(g))) throw new BadRequestException('车库选择无效');
  const supplied = numbers && typeof numbers === 'object' && !Array.isArray(numbers) ? numbers as Record<string, unknown> : {};
  const result: Record<string, string> = {};
  for (const garage of ['main', 'civil']) {
    if (!selected.includes(garage)) continue;
    const no = typeof supplied[garage] === 'string' ? (supplied[garage] as string).trim() : '';
    if (!no || !choices.some(s => s.garage === garage && s.spaceNo === no && !s.unavailableReason))
      throw new BadRequestException(`请从${garage === 'main' ? '二期大车库' : '二期人防车库'}档案选择有效车位号`);
    if (no.length > 20) throw new BadRequestException('车位号不能超过20字');
    result[garage] = no;
  }
  if ((selected.includes('main') || selected.includes('civil')) && !selected.includes('phase2')) throw new BadRequestException('地下车库须同时授权二期地面');
  return result;
}
