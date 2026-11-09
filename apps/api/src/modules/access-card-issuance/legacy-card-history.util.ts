import type { AccessCardLegacyHistoryEntry } from '../../entities/access-card-legacy-snapshot.entity';
import { icToWg, legacyRoomKey, parseLegacyAccessCardRoomName } from './access-card-routing';

export interface LegacyCardRow extends AccessCardLegacyHistoryEntry {
  /** PMS 内部 ID：优先捷顺 MC.CardInfo.ID，无卡记录时退回 HR.Person.ID。 */
  id: number;
  cardInfoId: number | null;
  personId: number;
  personNo: string;
  sequence: number;
  roomLabel: string;
  hidden: boolean;
  status: '在用' | '已隐藏';
  wgCardNo: string | null;
  personCreatedAt: string | null;
  lastSwipeAt: string | null;
  lastDevice: string | null;
}

/**
 * 捷顺发卡记录 → 新后台行。
 * 旧库 Person.Name 可能带“已隐藏”前缀，如“已隐藏228/50/202/4”；
 * 这里解析出 hidden 与基础房号，不把整串当房号。
 */
export function mapLegacyCardRow(
  row: AccessCardLegacyHistoryEntry,
  fallbackSequence = 1,
): LegacyCardRow {
  const rawName = (row.personName ?? '').trim();
  const hidden = /^\s*已隐藏/.test(rawName);
  const parsed = parseLegacyAccessCardRoomName(rawName);
  const roomLabel = parsed
    ? legacyRoomKey(parsed.lane, parsed.buildingNo, parsed.roomNo)
    : rawName.replace(/^\s*已隐藏\s*/, '');
  const icCardNo = row.icCardNo?.trim().toUpperCase() || null;
  let wgCardNo: string | null = null;
  if (icCardNo && /^[0-9A-F]{6,}$/.test(icCardNo)) {
    try { wgCardNo = icToWg(icCardNo); } catch { wgCardNo = null; }
  }
  const cardInfoId = typeof row.cardInfoId === 'number' ? row.cardInfoId : null;
  return {
    ...row,
    id: cardInfoId ?? row.personId,
    cardInfoId,
    personId: row.personId,
    personNo: row.personNo,
    sequence: row.sequence ?? parsed?.sequence ?? fallbackSequence,
    roomLabel,
    hidden,
    status: hidden ? '已隐藏' : '在用',
    wgCardNo,
    personCreatedAt: row.personCreatedAt ?? null,
    lastSwipeAt: row.lastSwipeAt ?? null,
    lastDevice: row.lastDevice ?? null,
  };
}

/** 解析页面地址/roomKey 为弄/楼/室；支持“已隐藏”前缀与省略弄号。 */
export function parseLegacyCardRoomInput(input?: string | null): {
  lane: string | null;
  buildingNo: string;
  roomNo: string;
} | null {
  const raw = (input ?? '').trim().replace(/^\s*已隐藏\s*/, '');
  if (!raw) return null;
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3) return { lane: parts[0], buildingNo: parts[1], roomNo: parts[2] };
  if (parts.length === 2) return { lane: null, buildingNo: parts[0], roomNo: parts[1] };
  const match = /(\d+)\D+(\d+)\D+([^/\s]+)/.exec(raw);
  return match ? { lane: match[1], buildingNo: match[2], roomNo: match[3] } : null;
}

export function normalizeLegacyNumber(value?: string | null): string {
  const trimmed = (value ?? '').trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
}
