import { ServiceUnavailableException } from '@nestjs/common';

const idFields = {
  楼表: ['lId'], 室表: ['sId', 'lId'], 业主表: ['zhId', 'sId'],
} as const;

/** 手工维度重灌专用；五个源 ID 均是 NOT NULL numeric(18,0)。 */
export function dimensionMirrorRows(result: unknown, source: keyof typeof idFields): Record<string, any>[] {
  const rows = (result as { recordsets?: unknown[] } | null)?.recordsets?.[0];
  if (!Array.isArray(rows)) throw new ServiceUnavailableException(`${source}源未返回结果集，未更新镜像`);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ServiceUnavailableException(`${source}源记录格式无效，未更新镜像`);
    }
    for (const field of idFields[source]) {
      // 即使数值暂在安全整数范围也不接受 Number，防止漏掉源端 varchar 转换。
      if (!Object.prototype.hasOwnProperty.call(row, field) || typeof row[field] !== 'string' || !/^-?\d{1,18}$/.test(row[field])) {
        // 不把住户标识等原始源值写进错误。
        throw new ServiceUnavailableException(`${source}源字段 ${field} 格式无效，未更新镜像`);
      }
    }
  }
  return rows;
}
