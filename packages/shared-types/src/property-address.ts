import { formatRoomText } from './address';

export const PROPERTY_TYPES = ['住宅', '公寓', '办公楼', '商铺'] as const;

/** 办公楼的楼层不是楼栋号。仍使用真实位置文本存房间，兼容既有工单和小程序。 */
export function composePropertyRoom(values: {
  propertyType?: string;
  floorNo?: number | null;
  roomNo?: string | null;
}): string {
  const room = String(values.roomNo ?? '').trim();
  if (values.propertyType !== '办公楼' || values.floorNo == null || !room) return room;
  return `${values.floorNo}楼${formatRoomText(room)}`;
}

/** 编辑时把规范位置文本拆回楼层和房间，不改变历史部门名。 */
export function splitOfficeRoom(roomNo: string): { floorNo?: number; roomNo: string } {
  const match = /^(\d{1,3})楼(.+)$/.exec(roomNo.trim());
  if (!match) return { roomNo };
  return { floorNo: Number(match[1]), roomNo: match[2].replace(/^(\d+)室$/, '$1') };
}
