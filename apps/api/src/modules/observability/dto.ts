import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const LOG_CATEGORIES = ['login', 'operation', 'error', 'alert', 'usage', 'feedback'] as const;
export const LOG_LEVELS = ['info', 'warning', 'error'] as const;
export const CLIENT_SOURCES = ['admin-web', 'miniapp-staff', 'miniapp-owner'] as const;
export const FEEDBACK_TYPES = ['error', 'hard_to_use', 'data_issue', 'suggestion', 'other'] as const;
export const FEEDBACK_STATUSES = ['new', 'processing', 'resolved', 'ignored'] as const;

export class FeedbackAttachmentDto {
  @IsIn(['image', 'video'])
  type: 'image' | 'video';

  @IsString()
  @MaxLength(800)
  url: string;
}

export class SystemLogQueryDto {
  @IsOptional()
  @IsIn(LOG_CATEGORIES)
  category?: (typeof LOG_CATEGORIES)[number];

  @IsOptional()
  @IsIn(LOG_LEVELS)
  level?: (typeof LOG_LEVELS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(30)
  source?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  success?: 'true' | 'false';

  @IsOptional()
  @IsIn(FEEDBACK_STATUSES)
  feedbackStatus?: (typeof FEEDBACK_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100)
  pageSize = 30;
}

export class PageViewDto {
  @IsString()
  @MaxLength(200)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class ClientErrorDto {
  @IsIn(CLIENT_SOURCES)
  source: (typeof CLIENT_SOURCES)[number];

  @IsString()
  @MaxLength(500)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  version?: string;
}

/** 用户主动提交的问题；页面和最近错误由端上自动附带。 */
export class UserFeedbackDto {
  @IsIn(CLIENT_SOURCES)
  source: (typeof CLIENT_SOURCES)[number];

  @IsIn(FEEDBACK_TYPES)
  type: (typeof FEEDBACK_TYPES)[number];

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  pageTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];
}

export class FeedbackStatusDto {
  @IsIn(FEEDBACK_STATUSES)
  status: (typeof FEEDBACK_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
