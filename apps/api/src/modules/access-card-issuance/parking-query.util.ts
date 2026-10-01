export type ParkingSearchKind = 'house' | 'plate' | 'plate_tail' | 'phone' | 'resident';

export interface ParsedParkingSearch {
  kind: ParkingSearchKind;
  term: string;
}

/**
 * 2.4.0 / 0.8.0 起，现场助手才会按房号、车牌尾号等类别选择字段并保留分隔符边界。
 * 更早版本仍会把查询词对大量文本列做 `%关键词%`，不能领取新的结构化查询任务。
 */
export function supportsStructuredParkingQueries(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > 2) return true;
  if (major === 2) return minor >= 4;
  return major === 0 && minor >= 8;
}

/** 部分旧停车库把标准房号写进了人员姓名栏，例如 `198-6-402/2`。 */
export function parkingLegacyRoomFromName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^已隐藏\s*/, '');
  const match = /^(198|228)[/-](\d{1,2})[/-](\d{2,4})(?:[/-]\d+)?$/.exec(normalized);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : null;
}

/**
 * 停车旧库不能再对几十个文本列执行无边界的 `%关键词%`。
 * 这里先判断用户输入的业务含义；现场助手再按同一类别选择字段和边界规则。
 */
export function parseParkingSearch(input: string): ParsedParkingSearch {
  const term = input.trim().replace(/\s+/g, ' ');
  if (!term) throw new Error('请输入房号、住户姓名、电话或车牌');

  const address = term
    .replace(/\s+/g, '')
    .replace(/[弄幢栋号]/g, '/')
    .replace(/室$/g, '')
    .replace(/\\/g, '/');
  if (/^(?:(?:198|228)[/-])?\d{1,2}[/-]\d{2,4}(?:[/-]\d+)?$/.test(address)) {
    return { kind: 'house', term: address.replace(/-/g, '/') };
  }

  const compact = term.replace(/\s+/g, '').toUpperCase();
  if (/^[\u4e00-\u9fff][A-Z][A-Z0-9挂学警港澳]{5,6}$/.test(compact)) {
    return { kind: 'plate', term: compact };
  }
  if (/^[A-Z0-9]{4,6}$/.test(compact)) {
    return { kind: 'plate_tail', term: compact };
  }

  const digits = term.replace(/[\s-]/g, '');
  if (/^\d{7,11}$/.test(digits)) return { kind: 'phone', term: digits };
  if (/^[\u4e00-\u9fff·]{2,20}$/.test(term)) return { kind: 'resident', term };

  if (/^\d{1,6}$/.test(digits)) {
    throw new Error('数字信息太少：查房号请输入“楼栋/室”，如 6/502；查车牌尾号至少输入 4 位；查电话至少输入 7 位');
  }
  throw new Error('无法识别查询内容：请输入房号（如 6/502）、住户姓名、7 位以上电话、完整车牌或至少 4 位车牌尾号');
}
