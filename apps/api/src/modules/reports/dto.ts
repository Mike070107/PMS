import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 报表通用参数：日期区间（YYYY-MM-DD，含首尾，按 Asia/Shanghai 取整天）+ 小区 */
export class ReportRangeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @Matches(DATE_RE, { message: 'from 必须是 YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to 必须是 YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}

export const WORK_ORDER_GROUP_BYS = ['day', 'assignee', 'community', 'repairType', 'status'] as const;
export type WorkOrderGroupBy = (typeof WORK_ORDER_GROUP_BYS)[number];

export class WorkOrderReportDto extends ReportRangeDto {
  @IsOptional()
  @IsIn(WORK_ORDER_GROUP_BYS)
  groupBy?: WorkOrderGroupBy;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigneeId?: number;
}

export class StaffReportDto extends ReportRangeDto {}

export class StockReportDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  /** '1' = 只看低于安全库存的 */
  @IsOptional()
  @IsString()
  onlyLow?: string;
}

export const MATERIAL_USAGE_GROUP_BYS = ['detail', 'day', 'assignee', 'material', 'warehouse', 'community'] as const;
export type MaterialUsageGroupBy = (typeof MATERIAL_USAGE_GROUP_BYS)[number];

export class MaterialUsageReportDto extends ReportRangeDto {
  @IsOptional()
  @IsIn(MATERIAL_USAGE_GROUP_BYS)
  groupBy?: MaterialUsageGroupBy;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigneeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  materialId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;
}

export class ReportOptionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;
}

/** 报表导出：与查询同一套筛选参数，导出当前范围；type 决定用哪份报表。 */
export const REPORT_EXPORT_TYPES = ['work-orders', 'staff', 'stock', 'material-usage'] as const;
export type ReportExportType = (typeof REPORT_EXPORT_TYPES)[number];

export class ReportExportDto {
  @IsIn(REPORT_EXPORT_TYPES)
  report: ReportExportType;

  @IsOptional()
  @Matches(DATE_RE, { message: 'from 必须是 YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to 必须是 YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  /** 工单按 day/assignee/community/repairType/status 分组；材料领用另有一组维度，服务端按报表类型校验 */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  groupBy?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigneeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  materialId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  onlyLow?: string;
}
