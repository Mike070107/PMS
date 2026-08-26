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

class WxServiceAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appId?: string;

  /** 留空（或原样提交脱敏串）= 保持不变，见 settings.service */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  templateOrderAssigned?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class DispatchEscalationDto {
  /** 0 = 关闭；其余 5～1440 分钟 */
  @IsInt()
  @Min(0)
  @Max(1440)
  acceptMinutes: number;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => DispatchEscalationDto)
  dispatchEscalation?: DispatchEscalationDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WxServiceAccountDto)
  wxServiceAccount?: WxServiceAccountDto;
}
