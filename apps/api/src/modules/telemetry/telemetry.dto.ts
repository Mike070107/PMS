import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
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

/** 页面访问来源白名单：网页端 / 员工小程序 / 业主小程序 */
export const PAGE_VIEW_SOURCES = ['web', 'miniapp-staff', 'miniapp-owner'] as const;
export type PageViewSource = (typeof PAGE_VIEW_SOURCES)[number];

export class PageViewItemDto {
  @IsString()
  @MaxLength(300)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  pageKey?: string;

  /** 客户端时间只作参考；偏差超过 5 分钟由服务端改用服务器时间。 */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  at?: string;

  /** 访问来源；不传时服务端按 x-client-source 请求头兜底。非法值在 DTO 层直接 400。 */
  @IsOptional()
  @IsIn([...PAGE_VIEW_SOURCES])
  source?: PageViewSource;
}

export class PageViewsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PageViewItemDto)
  views: PageViewItemDto[];
}

export class PageUsageQueryDto {
  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日期不合法' })
  from: string;

  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期不合法' })
  to: string;

  /** 预留：page_views 当前是租户级，不按小区过滤。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  communityId?: number;
}

/**
 * 使用统计下钻：页面 Top20 / 用户 Top20 点数字后打开明细。
 * from/to 缺省为近 7 天（含今天，Asia/Shanghai）；pageSize 上限 100。
 */
export class PageUsageDrilldownQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日期不合法' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期不合法' })
  to?: string;

  /** 页面路径（会按上报口径归一：去 query/hash 与末尾斜杠） */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  path?: string;

  /** 来源过滤：web / miniapp-staff / miniapp-owner */
  @IsOptional()
  @IsIn([...PAGE_VIEW_SOURCES])
  source?: PageViewSource;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  /** events=逐条访问；users=按用户聚合；pages=按页面聚合 */
  @IsOptional()
  @IsIn(['events', 'users', 'pages'])
  groupBy?: 'events' | 'users' | 'pages';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class LoginHistoryQueryDto {
  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日期不合法' })
  from: string;

  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期不合法' })
  to: string;

  @IsOptional()
  @IsIn(['all', 'success', 'failed'])
  status?: 'all' | 'success' | 'failed';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
