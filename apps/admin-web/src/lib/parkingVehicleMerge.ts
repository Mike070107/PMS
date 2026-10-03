export type ParkingDatabase = 'parking1' | 'parking2';

export type ParkingVehicleGroup<T> = {
  key: string;
  plate: string;
  rows: T[];
  parking1: T | null;
  parking2: T | null;
  merged: boolean;
};

export function normalizeParkingPlate(value: string): string {
  return value.replace(/[\s·]/g, '').trim().toUpperCase();
}

export function parkingDatabase(value: string): ParkingDatabase {
  return value.toLowerCase() === 'parking1' ? 'parking1' : 'parking2';
}

/**
 * 只有“一期一条 + 二期一条”才合并。同库重复车牌仍逐条显示，
 * 避免合并界面隐藏旧库脏数据，或让写入动作选错目标记录。
 */
export function groupParkingVehicleRows<T extends { database: string }>(
  rows: T[],
  plateOf: (row: T) => string,
  identityOf: (row: T) => string,
): ParkingVehicleGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  rows.forEach((row, index) => {
    const plate = normalizeParkingPlate(plateOf(row));
    const validPlate = plate && plate !== '车牌字段待识别';
    const key = validPlate ? `plate:${plate}` : `row:${parkingDatabase(row.database)}:${identityOf(row) || index}`;
    if (!buckets.has(key)) order.push(key);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  });

  const groups: ParkingVehicleGroup<T>[] = [];
  order.forEach((key) => {
    const bucket = buckets.get(key) ?? [];
    const phase1 = bucket.filter((row) => parkingDatabase(row.database) === 'parking1');
    const phase2 = bucket.filter((row) => parkingDatabase(row.database) === 'parking2');
    const canMerge = bucket.length === 2 && phase1.length === 1 && phase2.length === 1 && key.startsWith('plate:');
    if (canMerge) {
      groups.push({
        key,
        plate: normalizeParkingPlate(plateOf(bucket[0])),
        rows: [phase1[0], phase2[0]],
        parking1: phase1[0],
        parking2: phase2[0],
        merged: true,
      });
      return;
    }
    bucket.forEach((row, index) => groups.push({
        key: `${key}:${parkingDatabase(row.database)}:${identityOf(row) || index}`,
        plate: normalizeParkingPlate(plateOf(row)) || plateOf(row),
        rows: [row],
        parking1: parkingDatabase(row.database) === 'parking1' ? row : null,
        parking2: parkingDatabase(row.database) === 'parking2' ? row : null,
        merged: false,
      }));
  });
  return groups;
}

/** 同车牌在一期、二期各有一条时，续期必须同时落到两个停车库。 */
export function parkingRenewalTargets<T>(group: ParkingVehicleGroup<T>): T[] {
  return group.merged && group.parking1 && group.parking2
    ? [group.parking1, group.parking2]
    : [...group.rows];
}

export function normalizeParkingDate(value: string | null | undefined): string | null {
  const text = value?.trim() || '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match?.[1] ?? (text || null);
}

/** 第四段及以后是旧库为规避同房号主键冲突使用的自增号。 */
export function normalizeParkingRoomIdentity(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/[\\-]/g, '/') || '';
  if (!text) return null;
  const parts = text.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 4 && parts.slice(0, 3).every((part) => /^\d+$/.test(part)) && parts.slice(3).every((part) => /^\d+$/.test(part))
    ? parts.slice(0, 3).join('/')
    : parts.join('/');
}

export function sameParkingText(left: string | null | undefined, right: string | null | undefined): boolean {
  const clean = (value: string | null | undefined) => value?.replace(/\r\n?/g, '\n').trim() || null;
  return clean(left) === clean(right);
}
