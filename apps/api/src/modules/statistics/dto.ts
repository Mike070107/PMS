import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import {
  COLLECTION_GROUP_BYS,
  COLLECTION_MAX_DETAIL_LIMIT,
  COLLECTION_YEAR_MAX,
  COLLECTION_YEAR_MIN,
  type CollectionGroupBy,
} from './collection.util';
import { STATISTICS_TYPES, type StatisticsType } from './statistics.util';

const CODE_RE = /^[0-9A-Za-z]{1,20}$/;
const OFFICE_CODE_RE = /^\d{2}$/;
const PERIOD_RE = /^\d{4}(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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

  /** 收款起始日期（仅 received 生效）：paid_date >= paidDateFrom。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateFrom 必须是 YYYY-MM-DD' })
  paidDateFrom?: string;
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

  /** 收款起始日期（仅 received 生效）：paid_date >= paidDateFrom。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateFrom 必须是 YYYY-MM-DD' })
  paidDateFrom?: string;
}

export class StatisticsBillsQueryDto extends StatisticsAnnualDetailQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'sId 必须是房屋 id' })
  @Min(1)
  sId!: number;
}

/** P2-A 收费汇总类报表公共筛选：管理处/收费项目/房屋性质勾选与收款截止日期。 */
export class CollectionFiltersQueryDto {
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

  /** 收款截止日期：报表事件日期（收款日/退款日）<= paidDateTo。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;
}

/** 收费汇总/实收明细/日常日报表的日期区间；dateFrom、dateTo 必填。 */
export class CollectionDateRangeQueryDto extends CollectionFiltersQueryDto {
  @IsString({ message: 'dateFrom 必填' })
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom!: string;

  @IsString({ message: 'dateTo 必填' })
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo!: string;
}

export class CollectionSummaryQueryDto extends CollectionDateRangeQueryDto {
  /** 分组维度；不传默认 fee（收费项目）。 */
  @IsOptional()
  @IsIn(COLLECTION_GROUP_BYS, { message: 'groupBy 必须是 fee/office/method/cashier' })
  groupBy?: CollectionGroupBy;
}

export class CollectionDetailQueryDto extends CollectionDateRangeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1)
  @Max(COLLECTION_MAX_DETAIL_LIMIT, { message: `limit 不能超过 ${COLLECTION_MAX_DETAIL_LIMIT}` })
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset 必须是整数' })
  @Min(0)
  offset?: number;
}

export class CollectionDailyQueryDto extends CollectionDateRangeQueryDto {}

export class CollectionMonthlyQueryDto extends CollectionFiltersQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'year 必须是四位年度' })
  @Min(COLLECTION_YEAR_MIN, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  @Max(COLLECTION_YEAR_MAX, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  year!: number;
}
