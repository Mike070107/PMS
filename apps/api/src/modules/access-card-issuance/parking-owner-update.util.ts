import type { ParkingHistoryChange } from '../../entities/parking-history.entity';
import type { ParkingOwnerFieldHints, ParkingOwnerValues } from '../../entities/parking-owner-update.entity';
import type { ParkingSnapshotValues } from './parking-history.util';

const labels: Record<keyof ParkingOwnerValues, string> = {
  name: '姓名',
  phone: '电话',
  room: '房号',
  note: '备注',
};

export function normalizeParkingOwnerValues(input: Partial<ParkingOwnerValues> | undefined): ParkingOwnerValues {
  return {
    name: clean(input?.name),
    phone: clean(input?.phone),
    room: clean(input?.room),
    note: cleanMultiline(input?.note),
  };
}

export function normalizeParkingOwnerFieldHints(input: ParkingOwnerFieldHints | undefined): ParkingOwnerFieldHints {
  return Object.fromEntries(Object.entries(input ?? {}).flatMap(([key, value]) => {
    const cleaned = clean(value)?.replace(/^Owner__/, '') ?? null;
    return cleaned ? [[key, cleaned]] : [];
  })) as ParkingOwnerFieldHints;
}

export function parkingOwnerChanges(before: ParkingOwnerValues, after: ParkingOwnerValues): ParkingHistoryChange[] {
  return (Object.keys(labels) as Array<keyof ParkingOwnerValues>).flatMap((field) =>
    before[field] === after[field] ? [] : [{
      field,
      label: labels[field],
      before: before[field],
      after: after[field],
    }]);
}

/** 与助手 AppendPmsSource 保持一致：只有备注允许补 PMS 来源，其他读回值必须逐项一致。 */
export function parkingOwnerWriteMismatches(requested: ParkingOwnerValues, actual: ParkingOwnerValues): string[] {
  const expected = normalizeParkingOwnerValues(requested);
  const marker = '操作来源：PMS系统';
  if (!expected.note?.includes(marker)) expected.note = expected.note ? `${expected.note}\n${marker}` : marker;
  return parkingOwnerChanges(expected, normalizeParkingOwnerValues(actual)).map((change) => change.label);
}

/** P_Owner 电话/房号属于住户；Car_Issue.P_note 只属于目标车牌，不能扩散给同户其他车。 */
export function applyParkingOwnerSnapshot(
  snapshot: ParkingSnapshotValues, result: ParkingOwnerValues, plate: string,
): ParkingSnapshotValues {
  return {
    ...snapshot,
    ownerName: result.name,
    phone: result.phone,
    room: result.room,
    note: snapshot.plate?.trim().toUpperCase() === plate.trim().toUpperCase() ? result.note : snapshot.note,
  };
}

export function supportsParkingOwnerUpdates(version?: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 2) return major > 2 || minor >= 3;
  return major === 0 && minor >= 7;
}

/** 跨库车辆资料对齐需要助手 2.5.19 开始提供的双库锁行、冲突房号和回读核验。 */
export function supportsParkingVehicleSync(version?: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 2 || (major === 2 && (minor > 5 || (minor === 5 && patch >= 19)));
}

/** 联查结果存在 Owner__ 列时只从住户表取值，防止误把 Car_Issue 同名栏位当成住户资料。 */
export function parkingOwnerJoinedFieldValue(
  fields: Record<string, string | number | boolean | null>,
  aliases: readonly string[],
): string | null {
  const ownerEntries = Object.entries(fields).filter(([key]) => key.startsWith('Owner__'));
  const entries = ownerEntries.length
    ? ownerEntries.map(([key, value]) => [key.slice('Owner__'.length), value] as const)
    : Object.entries(fields).filter(([, value]) => value !== null && String(value).trim() !== '');
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_\-./]/g, '');
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias.replace(/^Owner__/, ''));
    const exact = entries.find(([key]) => normalize(key) === normalizedAlias);
    if (exact) return clean(exact[1]);
  }
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias.replace(/^Owner__/, ''));
    const partial = entries.find(([key]) => normalize(key).includes(normalizedAlias));
    if (partial) return clean(partial[1]);
  }
  return null;
}

/**
 * 枫桦旧停车库字段语义：P_Owner.owner_Name 保存房号，不保存姓名。
 * 姓名只接受明确的人名列，避免把 228-31-702 当成姓名。
 */
export function parkingLegacyOwnerValuesFromFields(
  fields: Record<string, string | number | boolean | null>,
): Pick<ParkingOwnerValues, 'name' | 'phone' | 'room'> {
  return {
    name: null,
    phone: clean(parkingOwnerJoinedFieldValue(fields,
      ['mobile', 'telephone', 'phone', 'tel', 'ptel', 'ownertel', 'ownermobile', 'ownerphone', '手机', '电话'])),
    room: clean(parkingOwnerJoinedFieldValue(fields,
      ['ownername', 'owner_name', 'roomno', 'houseno', 'owneradd', 'owneraddress', 'address', 'proom', 'roomnumber', 'addr', 'room', '房号', '地址'])),
  };
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function cleanMultiline(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).join('\n').trim();
  return text || null;
}
