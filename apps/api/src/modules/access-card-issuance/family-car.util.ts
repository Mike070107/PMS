/**
 * 亲情车管理的纯函数：有效期、车库默认值、旧库查重结果分类。
 * 不依赖数据库，便于单测锁住业务规则。
 */

export const FAMILY_RELATIONS = ['父母', '子女', '配偶', '兄弟姐妹', '祖父母/外祖父母', '孙子女/外孙子女', '其他亲属'] as const;
export const FAMILY_GARAGES = ['phase1', 'phase2', 'main', 'civil'] as const;
export const FAMILY_EXPIRY_REMIND_DAYS = 30;

export function normalizeFamilyPlate(value: unknown): string {
  return String(value ?? '').replace(/[\s·.．・]/g, '').toUpperCase();
}

export function isValidFamilyPlate(plate: string): boolean {
  return /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$/.test(plate);
}

/** 上海时区的日期（生效日、到期判断都按物业当地日期） */
export function shanghaiDate(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(Date.UTC(y, m - 1, d + days));
  return value.toISOString().slice(0, 10);
}

/** 有效期 1 年：生效日起至次年同日的前一天；2 月 29 日生效按 2 月 28 日到期。 */
export function familyValidity(startDate: string): { startDate: string; endDate: string } {
  const [y, m, d] = startDate.split('-').map(Number);
  const anniversary = new Date(Date.UTC(y + 1, m - 1, d));
  // 闰日次年没有 2/29，Date 会滚到 3/1，再减一天就是 2/28
  const end = new Date(anniversary.getTime() - 24 * 60 * 60 * 1000);
  return { startDate, endDate: end.toISOString().slice(0, 10) };
}

export function daysUntil(endDate: string, today: string): number {
  const toUtc = (value: string) => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(endDate) - toUtc(today)) / 86_400_000);
}

export function isExpiringSoon(endDate: string | null, today: string, days = FAMILY_EXPIRY_REMIND_DAYS): boolean {
  if (!endDate) return false;
  const left = daysUntil(endDate, today);
  return left >= 0 && left <= days;
}

/** 已过到期日（到期日当天仍有效） */
export function isPastEnd(endDate: string | null, today: string): boolean {
  return !!endDate && daysUntil(endDate, today) < 0;
}

export function databaseForLane(lane: string): 'parking1' | 'parking2' | null {
  if (lane === '198') return 'parking1';
  if (lane === '228') return 'parking2';
  return null;
}

/** 按弄自动选车库：198 弄开一期车库，228 弄开二期地面车库。 */
export function defaultFamilyGarages(lane: string): string[] {
  if (lane === '198') return ['phase1'];
  if (lane === '228') return ['phase2'];
  return [];
}

export function normalizeFamilyGarages(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map((item) => String(item)) : [];
  const unique = Array.from(new Set(list));
  const invalid = unique.find((item) => !(FAMILY_GARAGES as readonly string[]).includes(item));
  if (invalid) throw new Error(`不支持的车库：${invalid}`);
  if (!unique.length) throw new Error('请至少选择一个开通车库');
  return unique;
}

export function roomKey(lane: string, buildingNo: string, roomNo: string): string {
  return [lane, buildingNo, roomNo].map((part) => String(Number(part))).join('/');
}

// ---------- 旧库查询结果 ----------

export type LegacyRow = { database: string; fields: Record<string, string | number | boolean | null> };

function normalizeFieldName(value: string) {
  return value.toLowerCase().replace(/[\s_\-./]/g, '');
}

function field(row: LegacyRow, aliases: string[]): string | null {
  const entries = Object.entries(row.fields || {}).filter(([, value]) => value !== null && String(value).trim() !== '');
  for (const alias of aliases) {
    const hit = entries.find(([key]) => normalizeFieldName(key) === alias);
    if (hit) return String(hit[1]).trim();
  }
  return null;
}

export function legacyPlate(row: LegacyRow): string {
  return normalizeFamilyPlate(field(row, ['pplate', 'plate', 'carno', 'plateno', '车牌']) || '');
}

/** 旧库 Car_Brand（口述 Car_Beand）保存车辆身份文字 */
export function legacyIdentity(row: LegacyRow): string {
  return field(row, ['carbrand', 'carbeand', 'vehicleidentity', '车辆身份']) || '';
}

/** 旧库 owner_Name 实际保存房号，owner_Add 是地址；统一为 198/6/502 */
export function legacyRoomKey(row: LegacyRow): string | null {
  const raw = field(row, ['ownername', 'owneradd', 'owneraddress', 'roomno', '房号']);
  if (!raw) return null;
  const parts = raw.replace(/弄|号楼?|-|\\/g, '/').replace(/室/g, '').match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  return parts.slice(-3).map((part) => String(Number(part))).join('/');
}

export type PlateCheckOutcome =
  | { mode: 'new' }
  | { mode: 'existing'; databases: string[] }
  | { mode: 'conflict'; message: string };

/**
 * 根据一期、二期旧库按车牌查询的结果，判断这辆车怎么登记：
 * - 旧库没有 → 新登记（先暂存待审核车辆，零授权）；
 * - 旧库已有，且全部是本户的亲情车 → 续登 / 补登记（审核后只调整授权与续期）；
 * - 其余情况（别的房号、别的车辆身份）→ 不允许登记，避免把住户车改成亲情车。
 */
export function classifyPlateCheck(rows: LegacyRow[], plate: string, targetRoom: string): PlateCheckOutcome {
  const expected = normalizeFamilyPlate(plate);
  const matches = rows.filter((row) => legacyPlate(row) === expected);
  if (!matches.length) return { mode: 'new' };
  for (const row of matches) {
    const identity = legacyIdentity(row);
    const room = legacyRoomKey(row);
    const where = row.database === 'parking1' ? '一期停车库' : row.database === 'parking2' ? '二期停车库' : row.database;
    if (!identity.includes('亲情')) {
      return { mode: 'conflict', message: `车牌 ${expected} 已在${where}登记为「${identity || '未知身份'}」，不能登记为亲情车；请先在停车管理核对车辆资料` };
    }
    if (room && room !== targetRoom) {
      return { mode: 'conflict', message: `车牌 ${expected} 已在${where}登记为 ${room} 的亲情车，不能再登记到 ${targetRoom}` };
    }
  }
  return { mode: 'existing', databases: Array.from(new Set(matches.map((row) => row.database))) };
}
