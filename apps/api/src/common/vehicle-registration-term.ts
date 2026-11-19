import { BadRequestException } from '@nestjs/common';
import { addDays, addMonthsClamped } from '../modules/business/business-execution.util';

export type VehicleRegistrationTerm =
  | { mode: 'months'; months: number }
  | { mode: 'dates'; startDate: string; endDate: string; reason: string };

export const MAX_REGISTRATION_MONTHS = 60;

/** Strict ISO natural date: no timezone conversion, rollover or implicit coercion. */
export function isRegistrationDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeRegistrationTerm(input: unknown, defaultMonths = 12): VehicleRegistrationTerm {
  const value = input === undefined || input === null ? { mode: 'months', months: defaultMonths } : input;
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('请选择登记期限');
  const term = value as Record<string, unknown>;
  if (term.mode === 'months') {
    if (typeof term.months !== 'number' || !Number.isInteger(term.months) || term.months < 1 || term.months > MAX_REGISTRATION_MONTHS)
      throw new BadRequestException(`登记月数须为 1 至 ${MAX_REGISTRATION_MONTHS} 的整数`);
    if (term.startDate !== undefined || term.endDate !== undefined) throw new BadRequestException('按月登记不能同时指定日期');
    return { mode: 'months', months: term.months };
  }
  if (term.mode !== 'dates' || !isRegistrationDate(term.startDate) || !isRegistrationDate(term.endDate) || term.endDate < term.startDate)
    throw new BadRequestException('请填写合法的开始、结束日期，结束日期不得早于开始日期');
  if (term.months !== undefined) throw new BadRequestException('自定义日期不能同时指定月数');
  if (typeof term.reason !== 'string' || !term.reason.trim() || term.reason.trim().length > 500)
    throw new BadRequestException('自定义日期须填写原因（最多500字）');
  return { mode: 'dates', startDate: term.startDate, endDate: term.endDate, reason: term.reason.trim() };
}

/** Same clamped-month algorithm as paid parking; end = addMonths(start, n) - one day. */
export function registrationWindow(term: VehicleRegistrationTerm, activationDate: string) {
  if (!isRegistrationDate(activationDate)) throw new BadRequestException('登记生效日期无效');
  if (term.mode === 'dates') return { startDate: term.startDate, endDate: term.endDate };
  const endDate = addDays(addMonthsClamped(activationDate, term.months), -1);
  if (!isRegistrationDate(endDate)) throw new BadRequestException('登记期限超出支持范围');
  return { startDate: activationDate, endDate };
}
