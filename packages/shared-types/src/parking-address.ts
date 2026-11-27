export interface ParkingRoomAddress {
  lane: string;
  buildingNo: string;
  roomNo: string;
  key: string;
}

function normalizeAddressPart(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed.toUpperCase();
}

/** Recognize the legacy parking address and its known trailing annotations. */
export function parkingRoomAddress(value: string | null | undefined, database?: string | null): ParkingRoomAddress | null {
  if (!value) return null;
  const normalized = value.trim()
    .replace(/^已隐藏\s*/, '')
    .replace(/\s+/g, '')
    .replace(/(?:换车牌|新车|租客|租)$/, '')
    .replace(/[弄幢栋号]/g, '/')
    .replace(/室$/g, '')
    .replace(/[\\\-]/g, '/');
  const full = /^(198|228)\/(\d{1,2})\/(\d{2,4})(?:\/\d+)?$/.exec(normalized);
  const databaseName = database?.trim().toLowerCase();
  const inferredLane = databaseName === 'parking1' ? '198' : databaseName === 'parking2' ? '228' : null;
  // When the lane is omitted, accept only a two-part room or a short card sequence.
  const short = !full && inferredLane ? /^(\d{1,2})\/(\d{2,4})(?:\/\d{1,2})?$/.exec(normalized) : null;
  if (!full && !short) return null;
  const lane = full ? full[1] : inferredLane!;
  const buildingNo = normalizeAddressPart(full ? full[2] : short![1]);
  const roomNo = normalizeAddressPart(full ? full[3] : short![2]);
  return { lane, buildingNo, roomNo, key: `${lane}/${buildingNo}/${roomNo}` };
}

export function parkingPmsBuildingKey(lane: string | null | undefined, buildingNo: string | null | undefined): string | null {
  return lane && buildingNo ? [lane, buildingNo].map(normalizeAddressPart).join('/') : null;
}

export function parkingPmsHouseKey(lane: string | null | undefined, buildingNo: string | null | undefined, roomNo: string | null | undefined): string | null {
  const buildingKey = parkingPmsBuildingKey(lane, buildingNo);
  return buildingKey && roomNo ? `${buildingKey}/${normalizeAddressPart(roomNo)}` : null;
}

/** 旧车库的房号可落在姓名栏或地址栏；返回实际列名供资料编辑回显。 */
export function legacyParkingRoomField(fields: Record<string, unknown>) {
  const entries = Object.entries(fields);
  const joined = entries.filter(([key]) => /^Owner__/i.test(key));
  const candidates = (joined.length ? joined : entries).map(([key, value]) => ({
    column: key.replace(/^Owner__/i, ''),
    value: String(value ?? '').trim(),
  }));
  for (const alias of ['ownername', 'owneradd', 'roomno', 'roomnumber', 'houseno', 'owneraddress', 'address', 'addr', 'proom', 'room', '房号', '地址']) {
    for (const entry of candidates) {
      if (entry.column.toLowerCase().replace(/[\s_./-]/g, '') !== alias) continue;
      // 展示层只取原值；两段房号在已知车库才生成完整房产键。
      const full = parkingRoomAddress(entry.value);
      const parsed = full ?? parkingRoomAddress(entry.value, 'parking1');
      if (parsed) return { ...entry, lane: full?.lane, building: parsed.buildingNo, room: parsed.roomNo };
    }
  }
  return null;
}
