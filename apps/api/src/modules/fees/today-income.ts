import { BadRequestException } from '@nestjs/common';
import { MisTodayQueryDto } from './mis-fees.dto';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const incomeCategories = ['property', 'berth', 'garage', 'temporary', 'card', 'repair'] as const;
export type IncomeCategory = typeof incomeCategories[number];
export const incomeMisCodes = { property: '01', berth: '04', garage: '14' } as const;

export class IncomeQueryDto extends MisTodayQueryDto {
  @IsIn(incomeCategories.slice()) category!: IncomeCategory;
  @IsOptional() @IsIn(['mis', 'pms']) source?: 'mis' | 'pms';
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

export function incomePage(page: number | undefined, read: (offset: number, limit: number) => Promise<IncomePage>) {
  return read(page ? (page - 1) * 20 : 0, page ? 20 : 0);
}
