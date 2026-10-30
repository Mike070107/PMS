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
  // 商铺：lane 存路名（永德路），写回旧库用旧库同款写法「永德路169号商铺」
  if (!/^\d+$/.test(lane)) return `${lane}${buildingNo}号${roomNo}`;
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
  // 和导入同一口径：owner_Name / owner_Add / P_note 里认房号（含 (2) 序号、换车牌、备注后缀、商铺）
  const { room } = legacyRoomOfRow(row);
  if (!room) return null;
  return room.kind === 'house' ? `${room.lane}/${room.buildingNo}/${room.roomNo}` : `${room.road}${room.number}号商铺`;
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

// ---------- 旧库房号识别（亲情车导入 / 车牌按房号对应 PMS） ----------

export type LegacyRoomRef =
  | { kind: 'house'; lane: string; buildingNo: string; roomNo: string; source: string }
  | { kind: 'shop'; road: string; number: string; source: string };

/**
 * 旧停车库一条车的房号可能在三个地方，按顺序认：
 *   P_Owner.owner_Name（多数是房号：198-46-101(2)、198/14/102换车牌、已隐藏198-6-402/2），
 *   owner_Add（owner_Name 写成人名时，房号在这里：198/11/102），P_note。
 * 写法统一：弄/号/室、横杠、反斜杠都当分隔；末尾 (2)/（2）/ /2 是同户多卡序号；「换车牌」「已隐藏」是操作标记。
 * 商铺：永德路169号商铺、永德路187、永德路159商铺培训、宝秀路701号 → 路名 + 门牌号。
 * 只有两段写法（14/102）才按库补弄号：一期 parking1 补 198，二期 parking2 补 228。
 */
export function parseLegacyRoomText(text: string | null | undefined, database?: string | null): LegacyRoomRef | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^已隐藏\s*/, '')
    .replace(/\s+/g, '')
    .replace(/换车牌$/, '')
    .replace(/[（(]\d{1,2}[)）]$/, '')
    // 完整门牌后面跟的备注（198-27-602新业主、228-2-901租、20/501新车）：备注不影响房号
    .replace(/^(\d[\d/\\\-—–]*\d)[\u4e00-\u9fa5]{1,6}$/, '$1');
  const shop = /^([\u4e00-\u9fa5]{1,8}?路)(\d{1,5})/.exec(cleaned);
  if (shop) return { kind: 'shop', road: shop[1], number: String(Number(shop[2])), source: raw };
  const parts = cleaned
    .replace(/[弄号幢栋座]/g, '/')
    .replace(/室$/, '')
    .replace(/[\\\-—–]/g, '/')
    .split('/')
    .filter(Boolean);
  if (!parts.length || !parts.slice(0, 3).every((p) => /^\d+$/.test(p))) return null;
  const lane = database === 'parking1' ? '198' : database === 'parking2' ? '228' : null;
  if (parts.length >= 3 && /^(198|228)$/.test(parts[0])) {
    if (!parts.slice(3).every((p) => /^\d{1,2}$/.test(p))) return null; // 第四段起是同户多卡序号
    return { kind: 'house', lane: parts[0], buildingNo: String(Number(parts[1])), roomNo: String(Number(parts[2])), source: raw };
  }
  if (lane && (parts.length === 2 || (parts.length === 3 && /^\d{1,2}$/.test(parts[2]))) && parts[0].length <= 2 && parts[1].length >= 2) {
    return { kind: 'house', lane, buildingNo: String(Number(parts[0])), roomNo: String(Number(parts[1])), source: raw };
  }
  return null;
}

/** 一条旧库车的房号 + 车主（owner_Name 是人名时就是车主姓名） */
export function legacyRoomOfRow(row: LegacyRow): { room: LegacyRoomRef | null; personName: string | null; tried: string[] } {
  // 字段名有 Owner__owner_Name（联表）和 owner_Name 两种写法，按别名取
  const name = field(row, ['ownerownername', 'ownername', 'roomno', '房号']) || '';
  const add = field(row, ['ownerowneradd', 'owneradd', 'owneraddress']) || '';
  const note = field(row, ['pnote', 'note', '备注']) || '';
  const tried = [name, add, note].filter(Boolean);
  const room = parseLegacyRoomText(name, row.database) ?? parseLegacyRoomText(add, row.database) ?? parseLegacyRoomText(note, row.database);
  const personName = name && !parseLegacyRoomText(name, row.database) && /^[\u4e00-\u9fa5·]{2,5}$/.test(name) ? name : null;
  return { room, personName, tried };
}
