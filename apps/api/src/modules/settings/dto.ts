import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class OwnerPhoneAutoMatchDto {
  @IsBoolean()
  enabled: boolean;
}

class WxSubscribeTemplatesDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderDispatched?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderReview?: string;

  /** 员工端模板：有新工单派给维修工 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderAssigned?: string;
}

class AutoReviewDto {
  @IsInt()
  @Min(1)
  @Max(720)
  hours: number;
}

export class UpdateTenantSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnerPhoneAutoMatchDto)
  ownerPhoneAutoMatch?: OwnerPhoneAutoMatchDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WxSubscribeTemplatesDto)
  wxSubscribeTemplates?: WxSubscribeTemplatesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AutoReviewDto)
  autoReview?: AutoReviewDto;
}
