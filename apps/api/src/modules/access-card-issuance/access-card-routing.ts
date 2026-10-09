import { compareBuildingLike } from '../../common/natural-order';

export type ProjectPhase = 'phase1' | 'phase2';
export type DoorAccessSystem = 'mjsystem' | 'iccard' | null;

type AccessBuildingCandidate = {
  id: number;
  communityId: number;
  lane?: string | null;
  buildingNo: string;
};

const MJSYSTEM_BUILDINGS = new Set([
  '01', '02', '03', '05', '06', '07', '08', '09', '10', '18', '19', '20',
  '21', '22', '23', '25', '26', '32', '36',
]);
const ICCARD_BUILDINGS = new Set([
  '04', '11', '12', '13', '15', '16', '17', '31', '33', '35', '37', '40',
  '41', '42', '45', '46', '47', '48', '49', '50', '51', '52', '53',
]);

export function normalizeBuildingNo(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed.padStart(2, '0') : trimmed;
}

export function projectPhaseOf(communityName: string): ProjectPhase | null {
  if (communityName.includes('枫桦景苑一期')) return 'phase1';
  if (communityName.includes('枫桦景苑二期')) return 'phase2';
  return null;
}

export function accessSystemOf(phase: ProjectPhase, buildingNo: string): DoorAccessSystem {
  if (phase === 'phase1') return null;
  const normalized = normalizeBuildingNo(buildingNo);
  if (MJSYSTEM_BUILDINGS.has(normalized)) return 'mjsystem';
  if (ICCARD_BUILDINGS.has(normalized)) return 'iccard';
  return null;
}

function normalizeAreaPart(value?: string | null): string {
  return (value ?? '').trim();
}

/** 额外授权只能选择同一小区、同一弄号（即同一实际门禁区域）的楼栋。 */
export function belongsToSameAccessArea(
  current: Pick<AccessBuildingCandidate, 'communityId' | 'lane'>,
  candidate: Pick<AccessBuildingCandidate, 'communityId' | 'lane'>,
): boolean {
  return candidate.communityId === current.communityId
    && normalizeAreaPart(candidate.lane) === normalizeAreaPart(current.lane);
}

/** 返回当前门禁区域内已配置路由的楼栋，并按人类理解的数字顺序排列。 */
export function accessBuildingsForHouse<T extends AccessBuildingCandidate>(
  phase: ProjectPhase,
  current: Pick<AccessBuildingCandidate, 'communityId' | 'lane'>,
  buildings: T[],
): T[] {
  if (phase === 'phase1') return [];
  return buildings
    .filter((building) => belongsToSameAccessArea(current, building))
    .filter((building) => accessSystemOf(phase, building.buildingNo) !== null)
    .sort(compareBuildingLike);
}

export function legacyRoomKey(lane: string | null, buildingNo: string, roomNo: string): string {
  const displayBuilding = /^\d+$/.test(buildingNo) ? String(Number(buildingNo)) : buildingNo;
  return [lane, displayBuilding, roomNo].filter(Boolean).join('/');
}

/** 旧 JS0131625 人员 Name 历史上把纯数字楼号补成两位，如页面 228/5/301 → 库内 228/05/301。 */
export function legacyDatabaseRoomKey(lane: string | null, buildingNo: string, roomNo: string): string {
  const storedBuilding = /^\d+$/.test(buildingNo) ? buildingNo.padStart(2, '0') : buildingNo;
  return [lane, storedBuilding, roomNo].filter(Boolean).join('/');
}

/** 门禁软件用户姓名统一使用页面房号与该房累计发卡序号，如 228/16/401/6。 */
export function accessCardUserDisplayName(roomKey: string, sequence?: number | null): string {
  const normalizedRoomKey = roomKey.trim().replace(/\/+$/, '');
  return Number.isSafeInteger(sequence) && Number(sequence) > 0
    ? `${normalizedRoomKey}/${sequence}`
    : normalizedRoomKey;
}

/** 历史列表优先展示捷顺旧库真实登记名称；缺失时按房号与累计序号补齐。 */
export function accessCardHistoryRoomLabel(
  roomKey: string,
  sequence: number,
  legacyPersonName?: string | null,
): string {
  const storedName = legacyPersonName?.trim();
  return storedName || accessCardUserDisplayName(roomKey, sequence);
}

/** 2.5.29 起 .88 助手才会把完整显示姓名写入门禁数据库。 */
export function supportsAccessCardDisplayName(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 29)));
}

/** 2.5.30 起助手才会区分“只写门禁库”和“继续下发控制器”。 */
export function supportsAccessCardOperationMode(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 30)));
}

export function parseLegacyAccessCardRoomName(value?: string | null): {
  lane: string;
  buildingNo: string;
  roomNo: string;
  sequence: number;
} | null {
  const match = /^(?:已隐藏)?\s*(\d+)\s*\/\s*(\d+)\s*\/\s*([^/]+?)\s*\/\s*(\d+)\s*$/.exec(value?.trim() || '');
  if (!match) return null;
  return {
    lane: match[1],
    buildingNo: String(Number(match[2])),
    roomNo: match[3].trim(),
    sequence: Number(match[4]),
  };
}

/**
 * 旧库每张卡对应一个 HR.Person，Name 为 `基础房号/累计序号`。
 * 旧 PHP 用模糊匹配后的记录数 + 1；这里收窄成精确前缀，并兼顾历史缺号，
 * 避免 `228/5/30` 错数到 `228/5/301`，也避免删除过旧记录后复用已有序号。
 */
export function nextLegacyUserSequence(roomKey: string, personNames: string[]): {
  issuedCount: number;
  nextSequence: number;
} {
  const prefix = `${roomKey}/`;
  const sequences = personNames
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return {
    issuedCount: sequences.length,
    nextSequence: Math.max(sequences.length, ...sequences, 0) + 1,
  };
}

/** 与旧 PHP function_ICtoWG.php 保持相同字节顺序。 */
export function icToWg(icCardNo: string): string {
  const hex = icCardNo.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{6,}$/.test(hex)) throw new Error('IC 卡号必须是至少 6 位十六进制');
  const facility = Number.parseInt(hex.slice(4, 6), 16).toString().padStart(3, '0');
  const card = Number.parseInt(`${hex.slice(2, 4)}${hex.slice(0, 2)}`, 16)
    .toString()
    .padStart(5, '0');
  return `${facility}${card}`;
}

export function legacyDuplicateCardMessage(matches: Array<{
  personNo: string;
  personName: string;
  issuedAt: string | null;
}>): string {
  const match = matches[0];
  const issuedAt = match?.issuedAt
    ? `，原发卡时间 ${match.issuedAt.replace('T', ' ').slice(0, 19)}`
    : '';
  const duplicateCount = matches.length > 1 ? `（共查到 ${matches.length} 条重复记录）` : '';
  return `这张卡已在捷顺系统发过：${match?.personName || '原用户未知'}，捷顺系统编号 ${match?.personNo || '未知'}${issuedAt}${duplicateCount}。本次已停止，不会重复写卡。`;
}
