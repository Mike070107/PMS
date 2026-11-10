import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

/** HTTP 查询保留原字符串；仅兼容进程内仍传 safe integer 的旧调用。 */
export function annualIdInput(value: unknown): unknown {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
}

export const ANNUAL_ROOM_ID_RE = /^[1-9]\d{0,17}$/;

/** 年度逐笔入口仍只接受正房屋 ID，不接受指数、空白、数组或已舍入 Number。 */
export function annualRoomId(value: unknown): string {
  const id = annualIdInput(value);
  if (typeof id !== 'string' || !ANNUAL_ROOM_ID_RE.test(id)) {
    throw new BadRequestException('sId 必须是 1 至 18 位正整数字符串');
  }
  return id;
}

/** PG SELECT 必须先 ::text；不得用 String(unsafeNumber) 掩盖驱动已损失的精度。 */
export function annualSourceId(value: unknown): string {
  const id = annualIdInput(value);
  if (typeof id !== 'string' || !/^-?\d{1,18}$/.test(id)) {
    throw new ServiceUnavailableException('年度报表源标识无效，未返回不精确数据');
  }
  return id;
}
