import {
  IsArray,
  IsBoolean,
  ArrayMaxSize,
  ValidateNested,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BusinessBillingUnit,
  BusinessServiceType,
} from '../../common/enums';

export class BusinessRuleQueryDto {
  @IsOptional()
  @IsString()
  serviceType?: BusinessServiceType;
}

export class UpsertBusinessRuleDto {
  @IsString()
  serviceType: BusinessServiceType;

  @IsString()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number | null;

  @IsString()
  billingUnit: BusinessBillingUnit;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitPriceCents: number;

  @IsOptional()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class BusinessSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @IsString()
  serviceType?: BusinessServiceType;
}

export class EstimateBusinessDto {
  @IsString()
  serviceType: BusinessServiceType;

  @Type(() => Number)
  @IsInt()
  ruleId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ownerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vehicleId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  months?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  /** 续期：这辆车当前的到期日（多套系统取最早的），未到期时接着它往后续 */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  currentEndDate?: string;
}

/** 收银时这辆车要一起续期的停车系统（旧库记录 / 德立云停车场） */
export class ParkingSystemRefDto {
  @IsIn(['local', 'deliyun'])
  kind: 'local' | 'deliyun';

  @IsOptional()
  @IsIn(['parking1', 'parking2'])
  database?: 'parking1' | 'parking2';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  sourceRecordId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  previousEndDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  park?: string;

  @IsString()
  @MaxLength(40)
  label: string;
}

export class ReviewDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class HouseholdParkingQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  houseId: number;
}

export class CompleteBusinessDto extends EstimateBusinessDto {
  @IsOptional()
  @IsString()
  @IsIn(['cash', 'wechat', 'alipay', 'bank', 'other'])
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  /** 非标准续期（自定开始/结束日期）的实收金额（分）；填了就要物业经理审核后才执行 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  manualAmountCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  customReason?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ParkingSystemRefDto)
  parkingSystems?: ParkingSystemRefDto[];

  /** 新办车牌：收银台扫码登记单；车牌可以还没填（先收款，挂「待业主资料」） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  intakeId?: number;
}
