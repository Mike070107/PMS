import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** 三组勾选的可选值，前后端同一份口径 */
export const PART_CATEGORIES = ['self', 'shared', 'public'] as const;
export const FEE_CATEGORIES = [
  'owner',
  'repair_fund',
  'elevator_fund',
  'public_fund',
] as const;
export const SHARE_METHODS = ['natural', 'door', 'zone'] as const;

export class MaintenanceItemDto {
  @IsOptional() @IsString() @MaxLength(60) part?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @Type(() => Number) @IsNumber() surveyQty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() actualQty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() actualHours?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() measureQty?: number | null;
  @IsOptional() @IsString() @MaxLength(40) quotaCode?: string;
  @IsOptional() @Type(() => Number) @IsNumber() quotaHours?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() laborFeeCents?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() materialFeeCents?: number | null;
  @IsOptional() @IsString() @MaxLength(20) quality?: string;
  @IsOptional() @IsString() @MaxLength(60) note?: string;
}

export class MaintenanceMaterialDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(60) spec?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @Type(() => Number) @IsNumber() estQty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() pickQty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() usedQty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() returnQty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() amountCents?: number | null;
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}

/** 从工单开一张养护单；同一张工单重复调用返回已有的那张 */
export class CreateMaintenanceOrderDto {
  @Type(() => Number)
  @IsInt()
  workOrderId: number;
}

export class UpdateMaintenanceOrderDto {
  @IsOptional() @IsString() @MaxLength(40) paperNo?: string;
  @IsOptional() @IsString() @MaxLength(120) unitName?: string;
  @IsOptional() @IsString() @MaxLength(60) reporterName?: string;
  @IsOptional() @IsString() @MaxLength(60) addrVillage?: string;
  @IsOptional() @IsString() @MaxLength(60) addrRoad?: string;
  @IsOptional() @IsString() @MaxLength(30) addrLane?: string;
  @IsOptional() @IsString() @MaxLength(30) addrBuildingNo?: string;
  @IsOptional() @IsString() @MaxLength(30) addrRoom?: string;
  @IsOptional() @IsDateString() reportedOn?: string | null;
  @IsOptional() @IsString() @MaxLength(60) presentTime?: string;
  @IsOptional() @IsString() @MaxLength(120) faultPart?: string;
  @IsOptional() @IsString() @MaxLength(120) repairItem?: string;
  @IsOptional() @IsDateString() appointOn?: string | null;
  @IsOptional() @IsDateString() startOn?: string | null;
  @IsOptional() @IsDateString() finishOn?: string | null;

  @IsOptional() @IsIn([...PART_CATEGORIES, '']) partCategory?: string;
  @IsOptional() @IsIn([...FEE_CATEGORIES, '']) feeCategory?: string;
  @IsOptional() @IsIn([...SHARE_METHODS, '']) shareMethod?: string;
  @IsOptional() @IsString() @MaxLength(60) repairDateText?: string;
  @IsOptional() @IsString() @MaxLength(60) feeCategoryText?: string;
  @IsOptional() @IsString() @MaxLength(60) shareMethodText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => MaintenanceItemDto)
  items?: MaintenanceItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(70)
  @ValidateNested({ each: true })
  @Type(() => MaintenanceMaterialDto)
  materials?: MaintenanceMaterialDto[];

  @IsOptional() @IsString() @MaxLength(500) scrapNote?: string;
  @IsOptional() @IsString() @MaxLength(120) voucherIssue?: string;
  @IsOptional() @IsString() @MaxLength(120) serviceRecord?: string;
  @IsOptional() @IsString() @MaxLength(120) followUpRecord?: string;

  // ===== 签名 =====
  @IsOptional() @IsString() @MaxLength(500) fillerSignUrl?: string;
  @IsOptional() @IsString() @MaxLength(60) fillerName?: string;
  @IsOptional() @IsString() @MaxLength(500) repairerSignUrl?: string;
  @IsOptional() @IsString() @MaxLength(60) repairerName?: string;
  @IsOptional() @IsString() @MaxLength(500) ownerSignUrl?: string;
}

/** 物业经理查验：必须有手写签名，签了才算查过 */
export class InspectMaintenanceOrderDto {
  @IsString()
  @MaxLength(500)
  signUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  /** 查验日期（纸上只印月日）；不传 = 今天 */
  @IsOptional()
  @IsDateString()
  inspectedOn?: string;
}

export class MaintenanceQueryDto {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['draft', 'inspected', 'void', 'all']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() communityId?: number;
}

export class SaveQuotaItemDto {
  @IsString() @MaxLength(40) code: string;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) hours?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) materialFeeCents?: number;
  @IsOptional() @IsString() @MaxLength(255) remark?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

/** 定额取费参数：人工单价 + 取费系数 */
export class SaveQuotaParamsDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  laborRateCents: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  coefficient: number;
}
