import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
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

  /** 员工端模板：超时还没人接单，催办 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderOverdue?: string;
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

/** HH:mm，24 小时制 */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

class DispatchEscalationDto {
  /** 总开关；老后台不传这个字段时按 acceptMinutes 是不是 0 推断 */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 0 = 关闭（老口径，仍然收）；其余 5～1440 分钟 */
  @IsInt()
  @Min(0)
  @Max(1440)
  acceptMinutes: number;

  @IsOptional()
  @IsString()
  @Matches(CLOCK, { message: '催办时段起点要填 HH:mm' })
  startAt?: string;

  @IsOptional()
  @IsString()
  @Matches(CLOCK, { message: '催办时段终点要填 HH:mm' })
  endAt?: string;
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
