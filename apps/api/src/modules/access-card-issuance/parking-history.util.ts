import type { ParkingHistoryChange, ParkingHistoryEventType } from '../../entities/parking-history.entity';

export interface ParkingSnapshotValues {
  plate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  phone: string | null;
  room: string | null;
  note: string | null;
  plateChangedAt?: string | null;
}

export interface ParkingHistoryDraft {
  eventType: ParkingHistoryEventType;
  summary: string;
  changes: ParkingHistoryChange[];
  occurredAt?: string | null;
}

const PARKING_GARAGE_CHANNELS = [
  { database: 'parking1', label: '一期地面车库', channels: [5, 7] },
  { database: 'parking2', label: '二期地面车库', channels: [9, 11, 13] },
  { database: 'parking2', label: '二期大车库', channels: [15, 17, 19, 21] },
] as const;

/**
 * 历史表保留旧停车系统原始 256 位通道串，接口展示时再翻译为车库名称。
 * 旧系统中已经停用的人防通道不参与解释；二期人防权限只以德立云车牌数据为准。
 */
export function formatParkingGarageAuthorization(
  value: string | null,
  database?: string | null,
): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^[01]{16,}$/.test(normalized)) return normalized;
  const enabledChannels = new Set(Array.from(normalized).flatMap((bit, index) => bit === '1' ? [index + 1] : []));
  if (enabledChannels.size === 0) return '未授权任何车库';
  const normalizedDatabase = database?.trim().toLowerCase() || null;
  const garages = PARKING_GARAGE_CHANNELS
    .filter((garage) => !normalizedDatabase || garage.database === normalizedDatabase)
    .filter((garage) => garage.channels.some((channel) => enabledChannels.has(channel)))
    .map((garage) => garage.label);
  return garages.length ? garages.join('、') : '其他旧系统通道（已忽略）';
}

/**
 * 旧停车库有些版本会把 Car_ID 填成全 0 的占位值。它不是车辆记录主键，
 * 不能拿来建立快照，否则一次查询里的不同车辆会被串成同一条换牌链。
 */
export function normalizeParkingSourceRecordId(value: unknown): string | null {
  const result = value === null || value === undefined ? '' : String(value).trim();
  return result && !/^0+$/.test(result) ? result : null;
}

const OWNER_FIELDS: Array<{ key: keyof ParkingSnapshotValues; label: string }> = [
  { key: 'ownerName', label: '姓名' },
  { key: 'phone', label: '电话' },
  { key: 'room', label: '房号' },
  { key: 'note', label: '备注' },
];

/** 首次快照不制造历史；只有同一旧库记录前后确实不同才生成事件。 */
export function diffParkingSnapshot(
  before: ParkingSnapshotValues | null,
  after: ParkingSnapshotValues,
): ParkingHistoryDraft[] {
  if (!before) return [];
  const events: ParkingHistoryDraft[] = [];
  const plateChanged = before.plate !== after.plate && (before.plate || after.plate);
  const ownerRebound = before.ownerId !== after.ownerId && (before.ownerId || after.ownerId);
  const ownerChanges = OWNER_FIELDS
    .filter((field) => before[field.key] !== after[field.key])
    .map((field) => change(String(field.key), field.label, before[field.key], after[field.key]));

  // 一次旧库更新可能同时换牌和换绑，只记录一条“换牌”事件，避免同一操作在历史里出现两条。
  if (plateChanged) {
    const changes = [change('plate', '车牌', before.plate, after.plate)];
    if (ownerRebound) changes.push(change('ownerId', '绑定用户编号', before.ownerId, after.ownerId), ...ownerChanges);
    events.push({
      eventType: 'plate_change',
      summary: ownerRebound
        ? `车牌由 ${before.plate || '未记录'} 换为 ${after.plate || '未记录'}，绑定用户同时变更`
        : `车牌由 ${before.plate || '未记录'} 换为 ${after.plate || '未记录'}`,
      changes,
      occurredAt: after.plateChangedAt ?? null,
    });
  } else if (ownerRebound) {
    const changes = [change('ownerId', '绑定用户编号', before.ownerId, after.ownerId), ...ownerChanges];
    events.push({
      eventType: 'owner_rebind',
      summary: `车牌 ${after.plate || before.plate || '未记录'} 的绑定用户已变更`,
      changes,
    });
  } else if (ownerChanges.length) {
    events.push({
      eventType: 'owner_info_update',
      summary: `更新了${ownerChanges.map((item) => item.label).join('、')}`,
      changes: ownerChanges,
    });
  }
  return events;
}

function change(field: string, label: string, before: unknown, after: unknown): ParkingHistoryChange {
  return {
    field,
    label,
    before: value(before),
    after: value(after),
  };
}

function value(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const result = String(input).trim();
  return result || null;
}
