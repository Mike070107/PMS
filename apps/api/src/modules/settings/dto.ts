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
  IsNumber,
  IsIn,
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

  /** 员工端模板：办公室手动催修 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderUrge?: string;
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

/**
 * 大模型辅助识别。走 OpenAI 兼容协议，换服务商只改这三个字段。
 * apiKey 留空（或把页面回显的脱敏串原样交回来）= 保持不变，见 settings.service。
 */
class AiAssistDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;

  /** 1~30 秒。再长就不如直接退回规则结果 —— 现场没人对着转圈等 */
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(30000)
  timeoutMs?: number;

  /** 结果缓存天数，0 = 关闭 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  cacheDays?: number;

  /** 单价（元 / 百万 token），用来估算月账；0 = 不估算 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  priceInputMissPerM?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  priceInputHitPerM?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  priceOutputPerM?: number;
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

/** 采购审批链：三环开关 + 两个金额阈值（元）。都可选，没传的保持原值 */
class PurchaseApprovalDto {
  @IsOptional() @IsIn(['summary', 'approve', 'off']) office?: 'summary' | 'approve' | 'off';
  @IsOptional() @IsBoolean() manager?: boolean;
  @IsOptional() @IsBoolean() purchaser?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(10000000) skipManagerBelowYuan?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10000000) skipPurchaserBelowYuan?: number;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => PurchaseApprovalDto)
  purchaseApproval?: PurchaseApprovalDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiAssistDto)
  aiAssist?: AiAssistDto;
}
