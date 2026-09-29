export type ProjectPhase = 'phase1' | 'phase2';
export type DoorAccessSystem = 'mjsystem' | 'iccard' | null;

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

export function legacyRoomKey(lane: string | null, buildingNo: string, roomNo: string): string {
  const displayBuilding = /^\d+$/.test(buildingNo) ? String(Number(buildingNo)) : buildingNo;
  return [lane, displayBuilding, roomNo].filter(Boolean).join('/');
}

/** 旧 JS0131625 人员 Name 历史上把纯数字楼号补成两位，如页面 228/5/301 → 库内 228/05/301。 */
export function legacyDatabaseRoomKey(lane: string | null, buildingNo: string, roomNo: string): string {
  const storedBuilding = /^\d+$/.test(buildingNo) ? buildingNo.padStart(2, '0') : buildingNo;
  return [lane, storedBuilding, roomNo].filter(Boolean).join('/');
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
