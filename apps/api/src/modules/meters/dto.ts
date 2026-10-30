import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const METER_TYPES = ['water', 'electricity', 'gas', 'heat'] as const;
export const METER_STATUSES = ['active', 'disabled'] as const;
export const READING_STATUSES = ['pending', 'confirmed', 'void'] as const;
export const CHARGE_STATUSES = ['unpaid', 'partial', 'paid', 'void'] as const;

export class MeterQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string;

  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsIn(METER_STATUSES)
  status?: (typeof METER_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  /** 只看本月还没抄的表（按最后抄表时间落在本月之前算） */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  due?: boolean;

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

export class CreateMeterDto {
  @IsString()
  @Length(1, 64)
  meterNo: string;

  @IsIn(METER_TYPES)
  meterType: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100000)
  multiplier?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  integerDigits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  decimalDigits?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

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
  @MaxLength(255)
  installAddress?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  ownerPhone?: string;

  /** 分/单位。页面按元输入，提交前 ×100 取整 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  unitPriceCents?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  billingEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999999999)
  initialReading?: number;

  @IsOptional()
  @IsISO8601()
  initialReadingAt?: string;

  @IsOptional()
  @IsIn(METER_STATUSES)
  status?: (typeof METER_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

/** 更新：全部可选，只改传来的字段；meterNo/meterType 变更会同时改历史快照之外的表头 */
export class UpdateMeterDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  meterNo?: string;

  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100000)
  multiplier?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  integerDigits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  decimalDigits?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

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
  @MaxLength(255)
  installAddress?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  ownerPhone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  unitPriceCents?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  billingEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999999999)
  initialReading?: number;

  @IsOptional()
  @IsISO8601()
  initialReadingAt?: string;

  @IsOptional()
  @IsIn(METER_STATUSES)
  status?: (typeof METER_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class OcrQueryDto {
  /** 已通过 /upload 上传的原图 objectKey */
  @IsString()
  @MaxLength(255)
  imageKey: string;

  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  integerDigits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  decimalDigits?: number;

  /** 读数区域（0~1），不传则整图识别 */
  @IsOptional()
  @IsObject()
  crop?: { x: number; y: number; w: number; h: number };
}

export class ReadingOcrMetaDto {
  @IsOptional()
  @IsIn(['sidecar', 'llm', 'none'])
  provider?: 'sidecar' | 'llm' | 'none';

  @IsOptional()
  @IsIn(['success', 'failed', 'skipped'])
  status?: 'success' | 'failed' | 'skipped';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  confidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  meterNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(359)
  orientation?: number;

  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;
}

export class CreateReadingDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999999999)
  readingValue: number;

  /** 拍照时刻（ISO8601）。没传按服务端当前时间 */
  @IsOptional()
  @IsISO8601()
  readAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  photoWidth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  photoHeight?: number;

  @IsOptional()
  @IsObject()
  roi?: { x: number; y: number; w: number; h: number };

  @IsOptional()
  @ValidateNested()
  @Type(() => ReadingOcrMetaDto)
  ocr?: ReadingOcrMetaDto;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracy?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientRequestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** 管理后台补录/修正时明确标 manual；员工端默认 photo */
  @IsOptional()
  @IsIn(['photo', 'manual', 'import'])
  source?: 'photo' | 'manual' | 'import';
}

export class UpdateReadingDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999999999)
  readingValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;

  @IsOptional()
  @IsIn(READING_STATUSES)
  status?: (typeof READING_STATUSES)[number];
}

export class ReviewReadingDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999999999)
  readingValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}

export class ReadingQueryDto {
  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsIn(READING_STATUSES)
  status?: (typeof READING_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  meterId?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  anomalyOnly?: boolean;

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

export class ChargeQueryDto {
  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsIn(CHARGE_STATUSES)
  status?: (typeof CHARGE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string;

  /** YYYY-MM；不传按全部账期 */
  @IsOptional()
  @IsString()
  @MaxLength(7)
  period?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;
}

export class PayChargeDto {
  /** 本次实收金额（分）。不传按剩余应收全额 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000000)
  amountCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  method?: string;

  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  receiptNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdjustChargeDto {
  @Type(() => Number)
  @IsInt()
  @Min(-100000000)
  @Max(100000000)
  adjustmentCents: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class MeterSummaryQueryDto {
  /** YYYY-MM，默认本月（北京时间） */
  @IsOptional()
  @IsString()
  @MaxLength(7)
  period?: string;
}

export class OcrSampleQueryDto {
  @IsOptional()
  @IsIn(['candidate', 'training', 'trained', 'excluded'])
  status?: 'candidate' | 'training' | 'trained' | 'excluded';

  @IsOptional()
  @IsIn(METER_TYPES)
  meterType?: (typeof METER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string;

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

export class UpdateOcrSampleDto {
  @IsIn(['candidate', 'training', 'trained', 'excluded'])
  status: 'candidate' | 'training' | 'trained' | 'excluded';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
