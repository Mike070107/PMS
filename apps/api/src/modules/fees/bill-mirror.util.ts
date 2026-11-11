import { ServiceUnavailableException } from '@nestjs/common';

const numeric18 = /^-?\d{1,18}$/;
const idFields = ['zjId', 'lId', 'sId', 'zhId'] as const;

/** PG bigint 默认为字符串；仅兼容仍精确的旧数值水位，不修补已舍入的游标。 */
export function billCursorId(value: unknown): string {
  const text = typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
  if (text === null || !numeric18.test(text)) {
    throw new ServiceUnavailableException('账单同步游标格式无效，未推进水位');
  }
  return text;
}

/** CAST 后的源 ID 必须是字符串；主 keyset 全批校验后才允许任何 upsert。 */
export function billMirrorRows(result: unknown, after?: string): Record<string, any>[] {
  const rows = (result as { recordsets?: unknown[] } | null)?.recordsets?.[0];
  if (!Array.isArray(rows)) throw new ServiceUnavailableException('账单源未返回结果集，未推进水位');
  let previous = after === undefined ? undefined : BigInt(billCursorId(after));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ServiceUnavailableException('账单源记录格式无效，未推进水位');
    }
    for (const field of idFields) {
      if (!Object.prototype.hasOwnProperty.call(row, field) || typeof row[field] !== 'string' || !numeric18.test(row[field])) {
        throw new ServiceUnavailableException(`账单源字段 ${field} 格式无效，未推进水位`);
      }
    }
    if (previous !== undefined) {
      const current = BigInt(row.zjId);
      if (current <= previous) throw new ServiceUnavailableException('账单源主键分页未严格递增，未推进水位');
      previous = current;
    }
  }
  return rows;
}
