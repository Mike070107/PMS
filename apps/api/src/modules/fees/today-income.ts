import { BadRequestException } from '@nestjs/common';
import { MisTodayQueryDto } from './mis-fees.dto';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const incomeCategories = ['property', 'berth', 'garage', 'temporary', 'card', 'repair'] as const;
export type IncomeCategory = typeof incomeCategories[number];
export const incomeMisCodes = { property: '01', berth: '04', garage: '14' } as const;

export class IncomeQueryDto extends MisTodayQueryDto {
  @IsIn(incomeCategories.slice()) category!: IncomeCategory;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
}

export interface IncomeRow {
  paidAt: string; plate: string | null; period: string | null; amountCents: number; remark: string | null;
}
export interface IncomePage { total: number; amountCents: number; rows: IncomeRow[] }
export function incomeDay(date?: string) {
  const day = date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException('收费日期无效');
  return day;
}
export const emptyIncome = (): IncomePage => ({ total: 0, amountCents: 0, rows: [] });

// Sources with precise payment timestamps precede legacy entries carrying only a business date.
export async function incomePage(page: number | undefined, local: (offset: number, limit: number) => Promise<IncomePage>,
  legacy?: (offset: number, limit: number) => Promise<IncomePage>) {
  const offset = page ? (page - 1) * 20 : 0;
  const limit = page ? 20 : 0;
  const first = await local(offset, limit);
  if (!legacy) return first;
  const second = await legacy(Math.max(0, offset - first.total), limit - first.rows.length);
  return { total: first.total + second.total, amountCents: first.amountCents + second.amountCents, rows: [...first.rows, ...second.rows] };
}
