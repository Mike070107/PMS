import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const FEEDBACK_KINDS = ['suggestion', 'error'] as const;
export const FEEDBACK_STATUSES = ['pending', 'handled'] as const;
export const FEEDBACK_SOURCES = ['web', 'miniapp-staff', 'miniapp-owner'] as const;
export const FEEDBACK_MAX_ATTACHMENTS = 5;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 新客户端附件：地址必须是本系统 /upload/file，size/mime 由服务端按对象存储实测校正。 */
export class FeedbackAttachmentDto {
  @IsString()
  @MaxLength(1024)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FEEDBACK_MAX_ATTACHMENT_BYTES)
  size?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^(image|video|application)\/[\w.+-]+$/i)
  mime?: string;
}

export class FeedbackContextErrorDto {
  @IsString()
  @MaxLength(40)
  at: string;

  @IsString()
  @MaxLength(500)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  stack?: string;
}

/** 端上自动附带的现场信息，用于判断「是否需要看报错」。 */
export class FeedbackContextDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  appVersion?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => FeedbackContextErrorDto)
  recentErrors?: FeedbackContextErrorDto[];
}

export class CreateUserFeedbackDto {
  @IsString()
  @Length(1, 2000)
  content: string;

  /** 老字段：员工端小程序旧版本仍按 imageUrls/videoUrl 提交，保持兼容。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  imageUrls: string[] = [];

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  videoDurationSeconds?: number;

  /** 意见（suggestion）或异常（error）；缺省按旧客户端语义当意见建议。 */
  @IsOptional()
  @Matches(/^(suggestion|error)$/)
  kind?: (typeof FEEDBACK_KINDS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FEEDBACK_MAX_ATTACHMENTS)
  @ValidateNested({ each: true })
  @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => FeedbackContextDto)
  context?: FeedbackContextDto;

  @IsOptional()
  @Matches(/^(web|miniapp-staff|miniapp-owner)$/)
  source?: (typeof FEEDBACK_SOURCES)[number];
}

export class ListUserFeedbackDto {
  @IsOptional()
  @Matches(/^(suggestion|error)$/)
  kind?: (typeof FEEDBACK_KINDS)[number];

  @IsOptional()
  @Matches(/^(pending|handled)$/)
  status?: (typeof FEEDBACK_STATUSES)[number];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class UpdateUserFeedbackDto {
  /** 缺省 = 标记已处理；显式传 pending 可撤回。 */
  @IsOptional()
  @Matches(/^(pending|handled)$/)
  status?: (typeof FEEDBACK_STATUSES)[number];
}
