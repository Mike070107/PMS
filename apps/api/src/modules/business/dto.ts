import {
  IsBoolean,
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
}
