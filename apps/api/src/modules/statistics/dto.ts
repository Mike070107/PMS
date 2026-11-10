import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  COLLECTION_DETAIL_KINDS,
  COLLECTION_GROUP_BYS,
  COLLECTION_MAX_DETAIL_LIMIT,
  COLLECTION_YEAR_MAX,
  COLLECTION_YEAR_MIN,
  type CollectionDetailKind,
  type CollectionGroupBy,
} from './collection.util';
import {
  TICKET_STATUSES,
  type TicketStatus,
} from './ticket-report.util';
import {
  SIGNOFF_STATUSES,
  type SignoffStatus,
} from './misc-report.util';
import {
  ANALYSIS_SORTS,
  MONTHLY_REPORT_GROUP_BYS,
  type CollectionAnalysisSort,
  type MonthlyReportGroupBy,
} from './analysis.util';
import {
  ARREARS_PREPAID_GROUP_BYS,
  ARREARS_PREPAID_TABS,
  type ArrearsPrepaidGroupBy,
  type ArrearsPrepaidTab,
} from './arrears.util';
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

  /** 收款截止日期（P2-A 月报表旧口径沿用；P2-B 新报表用 dateFrom/dateTo 区间）。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;

  /** 收款方式名称多选（来自 options.paymentMethods 的 name）；空=全部。 */
  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true, message: 'paymentMethods 名称过长' })
  paymentMethods?: string[];

  /** 收款人精确筛选（单选）；空=全部。 */
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @IsString()
  @MaxLength(60)
  cashier?: string;

  /** 所属年度起止：substr(period,1,4) ∈ [yearFrom,yearTo]。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'yearFrom 必须是四位年度' })
  @Min(COLLECTION_YEAR_MIN)
  @Max(COLLECTION_YEAR_MAX)
  yearFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'yearTo 必须是四位年度' })
  @Min(COLLECTION_YEAR_MIN)
  @Max(COLLECTION_YEAR_MAX)
  yearTo?: number;
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
  /** 行类别：all=全部（收款/退款/调整），其余只看对应块；totals 随 kind 收敛。 */
  @IsOptional()
  @IsIn(COLLECTION_DETAIL_KINDS, { message: 'kind 必须是 all/received/refund/adjust' })
  kind?: CollectionDetailKind;

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

export class CollectionFeeNatureQueryDto extends CollectionDateRangeQueryDto {}

export class CollectionDailyQueryDto extends CollectionDateRangeQueryDto {}

export class CollectionMonthlyQueryDto extends CollectionFiltersQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'year 必须是四位年度' })
  @Min(COLLECTION_YEAR_MIN, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  @Max(COLLECTION_YEAR_MAX, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  year!: number;
}

/** P2-C 欠收/溢收公共筛选：统计年月 + 收款截止日 + 管理处/收费项目/房屋性质。 */
export class ArrearsPrepaidFiltersQueryDto {
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
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;
}

export class ArrearsPrepaidSummaryQueryDto extends ArrearsPrepaidFiltersQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsOptional()
  @IsIn(ARREARS_PREPAID_GROUP_BYS, { message: 'groupBy 必须是 office/fee' })
  groupBy?: ArrearsPrepaidGroupBy;
}

export class ArrearsPrepaidDetailQueryDto extends ArrearsPrepaidFiltersQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsOptional()
  @IsIn(ARREARS_PREPAID_TABS, { message: 'tab 必须是 arrears/prepaid' })
  tab?: ArrearsPrepaidTab;

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

export class ArrearsPrepaidBillsQueryDto extends ArrearsPrepaidFiltersQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsOptional()
  @IsIn(ARREARS_PREPAID_TABS, { message: 'tab 必须是 arrears/prepaid' })
  tab?: ArrearsPrepaidTab;

  @Type(() => Number)
  @IsInt({ message: 'sId 必须是房屋 id' })
  @Min(1)
  sId!: number;

  @Matches(CODE_RE, { message: 'feeCode 不合法' })
  feeCode!: string;
}

export class CollectionAssessmentQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'year 必须是四位年度' })
  @Min(COLLECTION_YEAR_MIN, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  @Max(COLLECTION_YEAR_MAX, { message: `year 必须在 ${COLLECTION_YEAR_MIN}–${COLLECTION_YEAR_MAX} 之间` })
  year!: number;

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
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'paidDateTo 必须是 YYYY-MM-DD' })
  paidDateTo?: string;

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
/** P2-D 收款分析（按户）。 */
export class CollectionAnalysisQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsString({ message: 'dateFrom 必填' })
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom!: string;

  @IsString({ message: 'dateTo 必填' })
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo!: string;

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
  @IsIn(ANALYSIS_SORTS, { message: 'sort 必须是 currentArrears/historyArrears/address' })
  sort?: CollectionAnalysisSort;

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

export class CollectionAnalysisDetailQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsString({ message: 'dateFrom 必填' })
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom!: string;

  @IsString({ message: 'dateTo 必填' })
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo!: string;

  @Type(() => Number)
  @IsInt({ message: 'sId 必须是房屋 id' })
  @Min(1)
  sId!: number;

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
}

/** P2-D 收费月报表（核心 9 指标版）。 */
export class MonthlyReportQueryDto {
  @IsString({ message: 'asOfPeriod 必填' })
  @Matches(PERIOD_RE, { message: 'asOfPeriod 必须是 YYYYMM' })
  asOfPeriod!: string;

  @IsOptional()
  @IsIn(MONTHLY_REPORT_GROUP_BYS, { message: 'groupBy 必须是 office' })
  groupBy?: MonthlyReportGroupBy;

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
}
/** P3-A 房产汇总。 */
export class PropertySummaryQueryDto {
  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(OFFICE_CODE_RE, { each: true, message: 'officeCodes 必须是两位管理处代码' })
  officeCodes?: string[];
}

/** P3-A 住户台账。 */
export class OwnerLedgerQueryDto {
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
  @Matches(CODE_RE, { each: true, message: 'natures 不合法' })
  natures?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'keyword 不能超过 50 个字符' })
  keyword?: string;

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

/** P3-A 楼房台账。 */
export class BuildingLedgerQueryDto {
  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(OFFICE_CODE_RE, { each: true, message: 'officeCodes 必须是两位管理处代码' })
  officeCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'keyword 不能超过 50 个字符' })
  keyword?: string;

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
/** P4-A 减免情况统计。 */
export class ReliefQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo?: string;

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
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'keyword 不能超过 50 个字符' })
  keyword?: string;

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

/** P4-A 签报情况统计。 */
export class SignoffQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo?: string;

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
  @MaxLength(60, { each: true, message: '签报类型不能超过 60 个字符' })
  types?: string[];

  @IsOptional()
  @IsIn(SIGNOFF_STATUSES, { message: 'status 必须是 all/effective/voided/open' })
  status?: SignoffStatus;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'keyword 不能超过 50 个字符' })
  keyword?: string;

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
/** P2-E 收款汇总表。 */
export class TicketSummaryQueryDto {
  @IsString({ message: 'dateFrom 必填' })
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom!: string;

  @IsString({ message: 'dateTo 必填' })
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo!: string;

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
  @MaxLength(30, { each: true, message: '收款方式名称不能超过 30 个字符' })
  paymentMethods?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'cashier 不能超过 50 个字符' })
  cashier?: string;

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

/** P4-B 开票数据（开票日期口径，不等同收款日期）。 */
export class TicketItemFiltersQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE)
  dateFrom?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE)
  dateTo?: string;

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(OFFICE_CODE_RE, { each: true })
  officeCodes?: string[];

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(CODE_RE, { each: true })
  feeCodes?: string[];
}

export class TicketItemsSummaryQueryDto extends TicketItemFiltersQueryDto {
  @IsOptional()
  @IsIn(['fee', 'office', 'day'])
  groupBy?: 'fee' | 'office' | 'day';
}

export class TicketItemsDetailQueryDto extends TicketItemFiltersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ticketNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECTION_MAX_DETAIL_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** P2-E 票据情况统计。 */
export class TicketsQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateFrom 必须是 YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : value))
  @Matches(DATE_RE, { message: 'dateTo 必须是 YYYY-MM-DD' })
  dateTo?: string;

  @IsOptional()
  @Transform(({ value }) => toCodeList(value))
  @IsArray()
  @IsString({ each: true })
  @Matches(OFFICE_CODE_RE, { each: true, message: 'officeCodes 必须是两位管理处代码' })
  officeCodes?: string[];

  @IsOptional()
  @IsIn(TICKET_STATUSES, { message: 'status 必须是 all/issued/pre_issue/voided/written_off' })
  status?: TicketStatus;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value == null ? undefined : String(value).trim()))
  @IsString()
  @MaxLength(50, { message: 'keyword 不能超过 50 个字符' })
  keyword?: string;

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