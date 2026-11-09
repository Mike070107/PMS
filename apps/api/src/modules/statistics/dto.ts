import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { STATISTICS_TYPES, type StatisticsType } from './statistics.util';

const CODE_RE = /^[0-9A-Za-z]{1,20}$/;
const OFFICE_CODE_RE = /^\d{2}$/;
const PERIOD_RE = /^\d{4}(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 逗号分隔或重复 query 参数都归一为字符串数组；空串视为未传（=全部）。 */
function toCodeList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const values = raw.map((item) => String(item).trim()).filter(Boolean);
  return values.length ? values : undefined;
}

export class StatisticsAnnualQueryDto {
  @IsIn(STATISTICS_TYPES, { message: 'type 必须是 arrears 或 received' })
  type!: StatisticsType;

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(OFFICE_CODE_RE, { each: true, message: 'officeCodes 必须是两位管理处代码' })
  officeCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(CODE_RE, { each: true, message: 'feeCodes 不合法' })
  feeCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(CODE_RE, { each: true, message: 'natures 不合法' })
  natures?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'yearFrom 必须是四位年度' })
  @Min(1990)
  @Max(2100)
  yearFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'yearTo 必须是四位年度' })
  @Min(1990)
  @Max(2100)
  yearTo?: number;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod?: string;

  /** 收款截止日期（仅 received 生效）：paid_date <= paidDateTo。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;
}

export class StatisticsAnnualDetailQueryDto {
  @IsIn(STATISTICS_TYPES, { message: 'type 必须是 arrears 或 received' })
  type!: StatisticsType;

  @Matches(OFFICE_CODE_RE, { message: 'officeCode 必须是两位管理处代码' })
  officeCode!: string;

  @Type(() => Number)
  @IsInt({ message: 'year 必须是四位年度' })
  @Min(1990)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(CODE_RE, { each: true, message: 'feeCodes 不合法' })
  feeCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(CODE_RE, { each: true, message: 'natures 不合法' })
  natures?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod?: string;

  /** 收款截止日期（仅 received 生效）：paid_date <= paidDateTo。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;
}

export class StatisticsBillsQueryDto extends StatisticsAnnualDetailQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'sId 必须是房屋 id' })
  @Min(1)
  sId!: number;
}
