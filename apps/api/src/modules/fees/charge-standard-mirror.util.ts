import { ServiceUnavailableException } from '@nestjs/common';

const invalid = (field: string): never => {
  // 不把住户标识/金额等源值写进异常或日志。
  throw new ServiceUnavailableException(`WYDJ 收费标准源字段 ${field} 格式无效，未更新镜像`);
};

const integer = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^-?\d{1,18}$/.test(value)) return invalid(field);
  return value;
};

const money = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  // SQL Server CONVERT(varchar(40), money, 2) 的精确四位输出；不经过 JS Number/整数分。
  if (typeof value !== 'string' || !/^-?\d{1,15}\.\d{4}$/.test(value)) return invalid(field);
  const units = BigInt(value.replace('.', ''));
  if (units < -9223372036854775808n || units > 9223372036854775807n) return invalid(field);
  return value;
};

export function chargeStandardMirrorParams(row: unknown): [string, string, string | null, string | null, string | null, string | null, boolean | null] {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid('record');
  const raw = row as Record<string, unknown>;
  for (const key of ['standardId', 'zhId', 'zlId', 'feeCode', 'je', 'bz', 'isHistory']) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return invalid(key);
  }
  const feeCode = raw.feeCode;
  if (feeCode !== null && typeof feeCode !== 'string') return invalid('DH');
  const history = raw.isHistory;
  if (history !== null && typeof history !== 'boolean') return invalid('Histroy');
  return [integer(raw.standardId, 'ID'), integer(raw.zhId, 'ZH_ID'),
    raw.zlId === null ? null : integer(raw.zlId, 'ZL_ID'), feeCode,
    money(raw.je, 'JE'), money(raw.bz, 'BZ'), history];
}
