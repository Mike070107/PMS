import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FeeBillStatus, FeeStandardStatus } from '../../common/enums';

/** 账期 YYYYMM（月份 01-12） */
const PERIOD_RE = /^\d{4}(0[1-9]|1[0-2])$/;
/** 日期 YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;
}

export class ListBillsQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  /** 房号 / 业主姓名 / 电话 / 收据号 模糊搜索 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  feeCode?: string;

  @IsOptional()
  @IsIn(Object.values(FeeBillStatus))
  status?: FeeBillStatus;

  @IsOptional()
  @Matches(PERIOD_RE, { message: '账期格式应为 YYYYMM' })
  periodFrom?: string;

  @IsOptional()
  @Matches(PERIOD_RE, { message: '账期格式应为 YYYYMM' })
  periodTo?: string;
}

export class ArrearsQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  feeCode?: string;
}

export class ListStandardsQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  feeCode?: string;

  @IsOptional()
  @IsIn(Object.values(FeeStandardStatus))
  status?: FeeStandardStatus;
}

export class CreateBillDto {
  @Type(() => Number)
  @IsInt()
  houseId: number;

  @IsString()
  @MaxLength(20)
  feeCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  feeName?: string;

  @Matches(PERIOD_RE, { message: '账期格式应为 YYYYMM' })
  period: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

export class UpdateBillDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  feeCode?: string;

  @IsOptional()
  @Matches(PERIOD_RE, { message: '账期格式应为 YYYYMM' })
  period?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

export class PayBillsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Type(() => Number)
  @IsInt({ each: true })
  ids: number[];

  /** 收款日期 YYYY-MM-DD，缺省 = 今天 */
  @IsOptional()
  @Matches(DATE_RE, { message: '收款日期格式应为 YYYY-MM-DD' })
  paidAt?: string;

  @IsString()
  @IsIn(['cash', 'wechat', 'alipay', 'bank', 'cheque', 'other'])
  paymentMethod: string;

  /** 收据号，留空自动生成，这一批账单共用 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  receiptNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  invoiceNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

export class CancelBillsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Type(() => Number)
  @IsInt({ each: true })
  ids: number[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class GenerateBillsDto {
  @Type(() => Number)
  @IsInt()
  communityId: number;

  @Matches(PERIOD_RE, { message: '账期格式应为 YYYYMM' })
  period: string;

  /** 不传 = 该小区所有费用项目 */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  feeCode?: string;
}

export class CreateStandardDto {
  @Type(() => Number)
  @IsInt()
  houseId: number;

  @IsString()
  @MaxLength(20)
  feeCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  feeName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  standardCents?: number;

  @Matches(DATE_RE, { message: '生效日期格式应为 YYYY-MM-DD' })
  effectiveFrom: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  docNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

export class UpdateStandardDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  standardCents?: number | null;

  @IsOptional()
  @Matches(DATE_RE, { message: '生效日期格式应为 YYYY-MM-DD' })
  effectiveFrom?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: '失效日期格式应为 YYYY-MM-DD' })
  effectiveTo?: string | null;

  @IsOptional()
  @IsIn(Object.values(FeeStandardStatus))
  status?: FeeStandardStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  docNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string | null;
}

// ---------------- 导入 ----------------

export class HouseLocatorDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  communityName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  buildingNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  roomNo?: string;
}

export class ImportStandardRowDto {
  @ValidateNested()
  @Type(() => HouseLocatorDto)
  house: HouseLocatorDto;

  @IsString()
  @MaxLength(20)
  feeCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  feeName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCents: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  standardCents?: number | null;

  @Matches(DATE_RE)
  effectiveFrom: string;

  @IsOptional()
  @Matches(DATE_RE)
  effectiveTo?: string | null;

  @IsOptional()
  @IsIn(Object.values(FeeStandardStatus))
  status?: FeeStandardStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  docNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string | null;

  @IsString()
  @MaxLength(60)
  legacyRef: string;
}

export class ImportBillRowDto {
  @ValidateNested()
  @Type(() => HouseLocatorDto)
  house: HouseLocatorDto;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  ownerName?: string | null;

  @IsString()
  @MaxLength(20)
  feeCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  feeName?: string;

  @Matches(PERIOD_RE)
  period: string;

  @Type(() => Number)
  @IsInt()
  amountCents: number;

  @IsOptional()
  @IsIn(Object.values(FeeBillStatus))
  status?: FeeBillStatus;

  /** ISO 时间或 YYYY-MM-DD */
  @IsOptional()
  @IsString()
  paidAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  paymentMethod?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  receiptNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  invoiceNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  cashier?: string | null;

  @IsOptional()
  @IsString()
  refundedAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string | null;

  @IsString()
  @MaxLength(60)
  legacyRef: string;
}

export class ImportFeesDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportStandardRowDto)
  standards?: ImportStandardRowDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportBillRowDto)
  bills?: ImportBillRowDto[];
}
