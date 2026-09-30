import type { ParkingHistoryChange, ParkingHistoryEventType } from '../../entities/parking-history.entity';

export interface ParkingSnapshotValues {
  plate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  phone: string | null;
  room: string | null;
  note: string | null;
}

export interface ParkingHistoryDraft {
  eventType: ParkingHistoryEventType;
  summary: string;
  changes: ParkingHistoryChange[];
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
  if (before.plate !== after.plate && (before.plate || after.plate)) {
    events.push({
      eventType: 'plate_change',
      summary: `车牌由 ${before.plate || '未记录'} 换为 ${after.plate || '未记录'}`,
      changes: [change('plate', '车牌', before.plate, after.plate)],
    });
  }

  if (before.ownerId !== after.ownerId && (before.ownerId || after.ownerId)) {
    const changes = [change('ownerId', '绑定用户编号', before.ownerId, after.ownerId)];
    for (const field of OWNER_FIELDS) {
      if (before[field.key] !== after[field.key]) {
        changes.push(change(String(field.key), field.label, before[field.key], after[field.key]));
      }
    }
    events.push({
      eventType: 'owner_rebind',
      summary: `车牌 ${after.plate || before.plate || '未记录'} 的绑定用户已变更`,
      changes,
    });
  } else {
    const changes = OWNER_FIELDS
      .filter((field) => before[field.key] !== after[field.key])
      .map((field) => change(String(field.key), field.label, before[field.key], after[field.key]));
    if (changes.length) {
      events.push({
        eventType: 'owner_info_update',
        summary: `更新了${changes.map((item) => item.label).join('、')}`,
        changes,
      });
    }
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
