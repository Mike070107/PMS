export type ParkingSearchKind = 'house' | 'plate' | 'plate_tail' | 'phone' | 'resident';

export interface ParsedParkingSearch {
  kind: ParkingSearchKind;
  term: string;
}

export interface ParkingRoomAddress {
  lane: string;
  buildingNo: string;
  roomNo: string;
  key: string;
}

function normalizeParkingAddressPart(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed.toUpperCase();
}

/**
 * 把旧停车库的房号统一成 PMS 房产可比较的键。
 * `198/6/402`、`198/06/402`、`198-6-402` 和中文地址写法均视为同一房产；
 * 末尾 `/5` 是旧库为同一住户多张卡追加的序号，不参与房产匹配。
 * 旧库名称末尾的“换车牌”是已确认的操作说明，只在生成匹配键时忽略，原字段保持不变。
 */
function parkingLaneForDatabase(database: string | null | undefined): '198' | '228' | null {
  const normalized = database?.trim().toLowerCase();
  if (normalized === 'parking1') return '198';
  if (normalized === 'parking2') return '228';
  return null;
}

export function parkingRoomAddress(
  value: string | null | undefined,
  database?: string | null,
): ParkingRoomAddress | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/^已隐藏\s*/, '')
    .replace(/\s+/g, '')
    .replace(/换车牌$/, '')
    .replace(/[弄幢栋号]/g, '/')
    .replace(/室$/g, '')
    .replace(/\\/g, '/')
    .replace(/-/g, '/');
  const fullMatch = /^(198|228)\/(\d{1,2})\/(\d{2,4})(?:\/\d+)?$/.exec(normalized);
  // 省略弄号时第三段存在歧义（例如 28/49/1202 可能是另一套地址体系），
  // 只接受两段房号，或末尾 1–2 位的已确认卡序号。
  const shortMatch = /^(\d{1,2})\/(\d{2,4})(?:\/\d{1,2})?$/.exec(normalized);
  const inferredLane = parkingLaneForDatabase(database);
  if (!fullMatch && (!shortMatch || !inferredLane)) return null;
  const lane = normalizeParkingAddressPart(fullMatch?.[1] ?? inferredLane!);
  const buildingNo = normalizeParkingAddressPart(fullMatch?.[2] ?? shortMatch![1]);
  const roomNo = normalizeParkingAddressPart(fullMatch?.[3] ?? shortMatch![2]);
  return { lane, buildingNo, roomNo, key: `${lane}/${buildingNo}/${roomNo}` };
}

/** PMS 房产表的弄、楼栋、房号使用同一套数字规范化，避免前导零造成漏联。 */
export function parkingPmsBuildingKey(
  lane: string | null | undefined,
  buildingNo: string | null | undefined,
): string | null {
  if (!lane || !buildingNo) return null;
  return [lane, buildingNo].map(normalizeParkingAddressPart).join('/');
}

export function parkingPmsHouseKey(
  lane: string | null | undefined,
  buildingNo: string | null | undefined,
  roomNo: string | null | undefined,
): string | null {
  const buildingKey = parkingPmsBuildingKey(lane, buildingNo);
  if (!buildingKey || !roomNo) return null;
  return `${buildingKey}/${normalizeParkingAddressPart(roomNo)}`;
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

/** 进出流水使用新版助手的精确车牌、时间区间和限量查询协议。 */
export function supportsParkingMovementQueries(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 24)))
    || (major === 0 && minor >= 9);
}

export function supportsParkingFeeReports(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 25)));
}

export function parseParkingFeeReportRange(startDate: string, endDate: string) {
  // 与进出流水共用日期合法性及 31 天上限；这里只借用校验，不限制车牌。
  const parseDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的报表日期');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('请选择有效的报表日期');
    return date;
  };
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (end.getTime() < start.getTime() || (end.getTime() - start.getTime()) / 86_400_000 > 30)
    throw new Error('金额报表每次最多查询连续 31 天');
  return { startDate, endDate };
}

export function parseParkingMovementRange(plateInput: string, startDate: string, endDate: string) {
  const plate = plateInput.trim().replace(/[\s·]/g, '').toUpperCase();
  if (!/^[\u4e00-\u9fff][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$/.test(plate)) {
    throw new Error('进出记录必须使用完整车牌号查询');
  }
  const parseDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的查询日期');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('请选择有效的查询日期');
    }
    return date;
  };
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days < 0 || days > 30) throw new Error('每次最多查询连续 31 天的进出记录');
  return { plate, startDate, endDate };
}

/** 旧停车库把标准房号写进 P_Owner.owner_Name，例如 `198-6-402/2`。 */
export function parkingLegacyRoomFromName(
  value: string | null | undefined,
  database?: string | null,
): string | null {
  const address = parkingRoomAddress(value, database);
  return address ? address.key : null;
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
  if (/^(?:198|228)[/-]\d{1,2}[/-]\d{2,4}(?:[/-]\d+)?$/.test(address)
      || /^\d{1,2}[/-]\d{2,4}(?:[/-]\d{1,2})?$/.test(address)) {
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

type ParkingQueryFieldValue = string | number | boolean | null;

export interface ParkingPlateDuplicateQuery {
  term: string;
  status: string;
  rows: Array<{ database: string; fields: Record<string, ParkingQueryFieldValue> }>;
  completedAt: Date | string | null;
}

export function normalizeParkingPlate(value: unknown): string {
  return String(value ?? '').trim().replace(/[\s·]/g, '').toUpperCase();
}

export function parkingPlateFromFields(fields: Record<string, ParkingQueryFieldValue>): string {
  const aliases = new Set(['pplate', 'carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌']);
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    if (aliases.has(normalizedKey)) return normalizeParkingPlate(value);
  }
  return '';
}

export function exactParkingPlateMatches(
  rows: ParkingPlateDuplicateQuery['rows'],
  plate: string,
): ParkingPlateDuplicateQuery['rows'] {
  const expected = normalizeParkingPlate(plate);
  return rows.filter((row) => parkingPlateFromFields(row.fields) === expected);
}

/**
 * 新增车牌必须引用一次刚完成的真实旧库查询，不能只信任前端的“未重复”状态。
 * 最终提交前再次校验查询词、完成时间和精确车牌结果，避免旧页面或并发操作绕过查重。
 */
export function assertFreshParkingPlateCheck(
  query: ParkingPlateDuplicateQuery,
  plate: string,
  now = new Date(),
  maxAgeMs = 5 * 60 * 1000,
): void {
  const expected = normalizeParkingPlate(plate);
  if (!expected) throw new Error('车牌不能为空');
  if (query.status !== 'completed' || !query.completedAt) throw new Error('车牌查重尚未完成，请重新查重');
  if (normalizeParkingPlate(query.term) !== expected) throw new Error('查重结果与当前车牌不一致，请重新查重');
  const completedAt = new Date(query.completedAt);
  if (!Number.isFinite(completedAt.getTime()) || now.getTime() - completedAt.getTime() > maxAgeMs) {
    throw new Error('车牌查重结果已超过 5 分钟，请重新查重');
  }
  const matches = exactParkingPlateMatches(query.rows, expected);
  if (matches.length) {
    const sources = Array.from(new Set(matches.map((row) => row.database.toLowerCase() === 'parking1'
      ? '枫桦景苑一期停车系统'
      : row.database.toLowerCase() === 'parking2' ? '枫桦景苑二期停车系统' : row.database)));
    throw new Error(`车牌 ${expected} 已存在于${sources.join('、')}，不能重复新增；请从查询结果办理续期、换牌或授权调整`);
  }
}
